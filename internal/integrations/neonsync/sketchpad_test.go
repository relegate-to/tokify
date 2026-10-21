package neonsync

import (
	"errors"
	"net/http/httptest"
	"testing"
)

func TestSketchpadRoundTripAndConflict(t *testing.T) {
	api := &fakeTimerAPI{}
	srv := httptest.NewServer(api)
	defer srv.Close()
	dek := testDEK(t)
	ctx, hc := t.Context(), srv.Client()

	state, err := readSketchpad(ctx, hc, srv.URL, "tok", dek)
	if err != nil || state.Version != 0 || state.HTML != "" {
		t.Fatalf("empty read = %+v, %v", state, err)
	}
	state, err = writeSketchpad(ctx, hc, srv.URL, "tok", dek, "alice", 0, "<p>One</p>")
	if err != nil || state.Version != 1 {
		t.Fatalf("first write = %+v, %v", state, err)
	}
	state, err = readSketchpad(ctx, hc, srv.URL, "tok", dek)
	if err != nil || state != (SketchpadState{Version: 1, Owner: "alice", HTML: "<p>One</p>"}) {
		t.Fatalf("read = %+v, %v", state, err)
	}

	if _, err = writeSketchpad(ctx, hc, srv.URL, "tok", dek, "alice", 1, "<p>Two</p>"); err != nil {
		t.Fatal(err)
	}
	fresh, err := writeSketchpad(ctx, hc, srv.URL, "tok", dek, "alice", 1, "<p>Stale</p>")
	if !errors.Is(err, ErrSketchpadConflict) || fresh.Version != 2 || fresh.HTML != "<p>Two</p>" {
		t.Fatalf("stale write = %+v, %v", fresh, err)
	}

	// The server cannot replay an old ciphertext under a newer version.
	api.row.Version = 3
	if _, err = readSketchpad(ctx, hc, srv.URL, "tok", dek); err == nil {
		t.Fatal("relabelled sketchpad decrypted")
	}
}
