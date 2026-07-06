package neonsync

import (
	"bytes"
	"path/filepath"
	"testing"
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

	// replace prunes down to the given set.
	if err = store.replace([][]byte{b}); err != nil {
		t.Fatal(err)
	}
	got, err = store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], b) {
		t.Fatalf("replace did not prune to [b]: %v", got)
	}

	// replace with empty clears the store.
	if err = store.replace(nil); err != nil {
		t.Fatal(err)
	}
	got, err = store.all()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("replace(nil) did not clear store: %d", len(got))
	}
}
