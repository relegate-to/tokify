package neonsync

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTimerAPI mimics the Data API over running_timers for one user: a first
// insert must be version 1 (a second insert is a 409), and a PATCH filtered on
// a stale version matches no row, as the schema trigger and RLS make it.
type fakeTimerAPI struct {
	mu  sync.Mutex
	row *runningTimerRow
}

func (f *fakeTimerAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.Method {
	case http.MethodGet:
		rows := []runningTimerRow{}
		if f.row != nil {
			rows = append(rows, *f.row)
		}
		_ = json.NewEncoder(w).Encode(rows)
	case http.MethodPost:
		var row runningTimerRow
		_ = json.NewDecoder(r.Body).Decode(&row)
		if f.row != nil {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"code":"23505","message":"duplicate key"}`)
			return
		}
		f.row = &row
		w.WriteHeader(http.StatusCreated)
	case http.MethodPatch:
		var row runningTimerRow
		_ = json.NewDecoder(r.Body).Decode(&row)
		want, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Query().Get("version"), "eq."), 10, 64)
		if f.row == nil || f.row.Version != want {
			_, _ = io.WriteString(w, "[]")
			return
		}
		f.row = &row
		_ = json.NewEncoder(w).Encode([]runningTimerRow{row})
	}
}

func testDEK(t *testing.T) []byte {
	t.Helper()
	dek, err := GenerateDEK()
	if err != nil {
		t.Fatal(err)
	}
	return dek
}

func TestRunningTimerRoundTrip(t *testing.T) {
	srv := httptest.NewServer(&fakeTimerAPI{})
	defer srv.Close()
	dek := testDEK(t)
	ctx, hc := t.Context(), srv.Client()

	state, err := readTimer(ctx, hc, srv.URL, "tok", dek)
	if err != nil || state.Version != 0 || state.Timer != nil {
		t.Fatalf("empty read = %+v, %v", state, err)
	}

	start := time.Date(2026, 10, 1, 9, 30, 15, 0, time.UTC)
	running := RunningTimer{Description: "Write plan", Project: "tokify", Tags: []string{"docs"}, Start: start, DeviceID: "mac"}
	state, err = writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", 0, running)
	if err != nil || state.Version != 1 {
		t.Fatalf("first write = %+v, %v", state, err)
	}

	end := start.Add(time.Hour)
	stopped := running
	stopped.End = &end
	if state, err = writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", 1, stopped); err != nil || state.Version != 2 {
		t.Fatalf("stop = %+v, %v", state, err)
	}

	state, err = readTimer(ctx, hc, srv.URL, "tok", dek)
	if err != nil {
		t.Fatal(err)
	}
	got := state.Timer
	if state.Version != 2 || got.Description != "Write plan" || !got.Start.Equal(start) ||
		got.End == nil || !got.End.Equal(end) || got.Tags[0] != "docs" || got.DeviceID != "mac" {
		t.Fatalf("read back %+v at version %d", got, state.Version)
	}
}

func TestRunningTimerStaleWriteConflicts(t *testing.T) {
	srv := httptest.NewServer(&fakeTimerAPI{})
	defer srv.Close()
	dek := testDEK(t)
	ctx, hc := t.Context(), srv.Client()

	mac := RunningTimer{Description: "On the Mac", Start: time.Now(), DeviceID: "mac"}
	if _, err := writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", 0, mac); err != nil {
		t.Fatal(err)
	}

	// The phone read nothing before the Mac's first write landed.
	phone := RunningTimer{Description: "On the phone", Start: time.Now(), DeviceID: "phone"}
	fresh, err := writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", 0, phone)
	if !errors.Is(err, ErrTimerConflict) || fresh.Version != 1 || fresh.Timer.DeviceID != "mac" {
		t.Fatalf("racing insert = %+v, %v", fresh, err)
	}

	// Retrying on the fresh version wins.
	if _, err = writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", fresh.Version, phone); err != nil {
		t.Fatal(err)
	}

	// The Mac still thinks it is at version 1.
	fresh, err = writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", 1, mac)
	if !errors.Is(err, ErrTimerConflict) || fresh.Version != 2 || fresh.Timer.DeviceID != "phone" {
		t.Fatalf("stale update = %+v, %v", fresh, err)
	}
}

func TestRunningTimerRejectsRelabelledVersion(t *testing.T) {
	api := &fakeTimerAPI{}
	srv := httptest.NewServer(api)
	defer srv.Close()
	dek := testDEK(t)
	ctx, hc := t.Context(), srv.Client()

	old := RunningTimer{Description: "Old", Start: time.Now()}
	if _, err := writeTimer(ctx, hc, srv.URL, "tok", dek, "alice", 0, old); err != nil {
		t.Fatal(err)
	}
	// A server replaying version 1's ciphertext as version 5.
	api.row.Version = 5
	if _, err := readTimer(ctx, hc, srv.URL, "tok", dek); err == nil {
		t.Fatal("want decrypt failure for a relabelled version")
	}
}

func TestRunningTimerRejectsOtherKey(t *testing.T) {
	srv := httptest.NewServer(&fakeTimerAPI{})
	defer srv.Close()
	ctx, hc := t.Context(), srv.Client()

	if _, err := writeTimer(ctx, hc, srv.URL, "tok", testDEK(t), "alice", 0, RunningTimer{Start: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := readTimer(ctx, hc, srv.URL, "tok", testDEK(t)); err == nil {
		t.Fatal("want decrypt failure under a different DEK")
	}
}
