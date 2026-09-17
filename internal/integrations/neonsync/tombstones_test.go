package neonsync

import (
	"bytes"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

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
