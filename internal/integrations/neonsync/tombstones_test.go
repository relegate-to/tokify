package neonsync

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
)

func TestTombstoneStoreRoundTrip(t *testing.T) {
	store := newTombstoneStore(filepath.Join(t.TempDir(), "neonsync.json"))

	// Empty store reads as no tombstones, not an error.
	got, err := store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("fresh store not empty: %d", len(got))
	}

	a := []byte(`{"d":"one"}`)
	b := []byte(`{"d":"two"}`)
	if err = store.add(a); err != nil {
		t.Fatal(err)
	}
	// Adding the same canonical twice de-duplicates.
	if err = store.add(a); err != nil {
		t.Fatal(err)
	}
	if err = store.add(b); err != nil {
		t.Fatal(err)
	}

	got, err = store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 tombstones after dedup, got %d", len(got))
	}
	if !bytes.Equal(got[0], a) || !bytes.Equal(got[1], b) {
		t.Fatalf("round-trip mismatch: %q, %q", got[0], got[1])
	}

	// retain prunes down to the tombstones the predicate keeps.
	if err = store.retain(func(c []byte) bool { return bytes.Equal(c, b) }); err != nil {
		t.Fatal(err)
	}
	got, err = store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], b) {
		t.Fatalf("retain did not prune to [b]: %v", got)
	}

	// retain nothing clears the store.
	if err = store.retain(func([]byte) bool { return false }); err != nil {
		t.Fatal(err)
	}
	got, err = store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("retain(none) did not clear store: %d", len(got))
	}
}

// Separate store values share nothing in memory, like the desktop app and its
// MCP server process, so only the file lock keeps these adds from clobbering
// each other or being dropped by a concurrent prune.
func TestTombstoneStoreConcurrentWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neonsync.json")
	stores := []*tombstoneStore{newTombstoneStore(path), newTombstoneStore(path)}

	var wg sync.WaitGroup
	const perStore = 40
	for si, store := range stores {
		for i := range perStore {
			wg.Go(func() {
				if err := store.add(fmt.Appendf(nil, `{"d":"%d-%d"}`, si, i)); err != nil {
					t.Error(err)
				}
				if err := store.retain(func([]byte) bool { return true }); err != nil {
					t.Error(err)
				}
			})
		}
	}
	wg.Wait()

	got, err := stores[0].all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(stores)*perStore {
		t.Fatalf("want %d tombstones, got %d", len(stores)*perStore, len(got))
	}
}

func TestPendingDeletionsKeepsTombstonesRecordedMidSync(t *testing.T) {
	store := newTombstoneStore(filepath.Join(t.TempDir(), "neonsync.json"))
	s := &Service{tombstones: store}
	dek := bytes.Repeat([]byte{7}, 32)

	recreated := []byte(`{"d":"recreated"}`)
	deleted := []byte(`{"d":"deleted"}`)
	late := []byte(`{"d":"late"}`)
	for _, c := range [][]byte{recreated, deleted} {
		if err := store.add(c); err != nil {
			t.Fatal(err)
		}
	}
	tombstoned, err := store.all()
	if err != nil {
		t.Fatal(err)
	}
	// Recorded by another process after this sync read the tombstones.
	if err = store.add(late); err != nil {
		t.Fatal(err)
	}

	del, err := s.pendingDeletions(dek, tombstoned, map[string]models.Activity{EntryID(dek, recreated): {}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := del[EntryID(dek, deleted)]; !ok || len(del) != 1 {
		t.Fatalf("want only the deleted entry pending, got %v", del)
	}

	got, err := store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !bytes.Equal(got[0], deleted) || !bytes.Equal(got[1], late) {
		t.Fatalf("want [deleted late] kept, got %q", got)
	}
}

func TestPendingRestorationsOnlyRevivesActivitiesStillPresent(t *testing.T) {
	store := newRestorationStore(filepath.Join(t.TempDir(), "neonsync.json"))
	s := &Service{restores: store}
	dek := bytes.Repeat([]byte{8}, 32)

	live := []byte(`{"d":"live"}`)
	deletedAgain := []byte(`{"d":"deleted-again"}`)
	late := []byte(`{"d":"late"}`)
	for _, c := range [][]byte{live, deletedAgain} {
		if err := store.add(c); err != nil {
			t.Fatal(err)
		}
	}
	restored, err := store.all()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.add(late); err != nil {
		t.Fatal(err)
	}

	ids, err := s.pendingRestorations(dek, restored, map[string]models.Activity{EntryID(dek, live): {}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ids[EntryID(dek, live)]; !ok || len(ids) != 1 {
		t.Fatalf("want only the live entry pending restoration, got %v", ids)
	}

	got, err := store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !bytes.Equal(got[0], live) || !bytes.Equal(got[1], late) {
		t.Fatalf("want [live late] kept, got %q", got)
	}
}

func TestRecordRestorationPersistsAndCancelsMatchingTombstone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neonsync.json")
	s := &Service{
		settings:   Settings{DataURL: "https://example.invalid"},
		tombstones: newTombstoneStore(path),
		restores:   newRestorationStore(path),
	}
	start := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	activity := models.Activity{Description: "Restore", StartTime: start, EndTime: &end}
	canonical := canonicalize(activity)
	if err := s.tombstones.add(canonical); err != nil {
		t.Fatal(err)
	}

	if err := s.RecordRestoration(activity); err != nil {
		t.Fatal(err)
	}
	tombstones, err := s.tombstones.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(tombstones) != 0 {
		t.Fatalf("matching tombstone was not cancelled: %q", tombstones)
	}
	restores, err := s.restores.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(restores) != 1 || !bytes.Equal(restores[0], canonical) {
		t.Fatalf("restoration was not persisted: %q", restores)
	}
}

func TestMarkRestoredClearsCloudTombstone(t *testing.T) {
	var (
		method string
		path   string
		body   []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.RequestURI()
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	err := markRestored(t.Context(), srv.Client(), srv.URL, "token", []string{"abc", "def"})
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPatch {
		t.Fatalf("want PATCH, got %s", method)
	}
	if path != "/entries?id=in.(abc,def)" {
		t.Fatalf("unexpected path %q", path)
	}
	if string(body) != `{"deleted":false}` {
		t.Fatalf("unexpected body %q", body)
	}
}
