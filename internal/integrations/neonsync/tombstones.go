package neonsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/go-faster/errors"
)

// tombstoneStore persists entries that were deleted locally but whose deletion
// has not yet been confirmed in the cloud. Each element is the base64 of an
// entry's canonical bytes (see canonicalize) — the exact preimage EntryID
// hashes — so the sync can recompute the keyed content id once the DEK is
// available and flip the matching cloud row's `deleted` flag to true. Without
// this record a delete is indistinguishable from an entry that simply hasn't
// been pulled yet, and the pull step resurrects it.
//
// Stored as plaintext alongside neonsync.json; it exposes nothing that the
// ~/.tock.txt log does not already hold in the clear.
type tombstoneStore struct {
	path string
	mu   sync.Mutex
}

func newTombstoneStore(settingsPath string) *tombstoneStore {
	return &tombstoneStore{path: filepath.Join(filepath.Dir(settingsPath), "neonsync-tombstones.json")}
}

type tombstoneFile struct {
	Deleted []string `json:"deleted"`
}

// load reads the persisted base64 canonicals. Caller must hold t.mu.
func (t *tombstoneStore) load() ([]string, error) {
	data, err := os.ReadFile(t.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, errors.Wrap(err, "read tombstones")
	}
	var f tombstoneFile
	if uerr := json.Unmarshal(data, &f); uerr != nil {
		return nil, errors.Wrap(uerr, "unmarshal tombstones")
	}
	return f.Deleted, nil
}

// save rewrites the file. Caller must hold t.mu.
func (t *tombstoneStore) save(encoded []string) error {
	if err := os.MkdirAll(filepath.Dir(t.path), 0o700); err != nil {
		return errors.Wrap(err, "ensure tombstones dir")
	}
	data, err := json.MarshalIndent(tombstoneFile{Deleted: encoded}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "marshal tombstones")
	}
	if werr := os.WriteFile(t.path, data, 0o600); werr != nil {
		return errors.Wrap(werr, "write tombstones")
	}
	return nil
}

// add records one canonical-bytes tombstone, de-duplicating.
func (t *tombstoneStore) add(canonical []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	encoded, err := t.load()
	if err != nil {
		return err
	}
	enc := b64(canonical)
	if slices.Contains(encoded, enc) {
		return nil
	}
	return t.save(append(encoded, enc))
}

// all returns the tombstoned entries as canonical byte slices.
func (t *tombstoneStore) all() ([][]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	encoded, err := t.load()
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(encoded))
	for _, e := range encoded {
		raw, derr := unb64(e)
		if derr != nil {
			continue // a corrupt entry can't be matched anyway; drop it
		}
		out = append(out, raw)
	}
	return out, nil
}

// replace overwrites the tombstone set with the given canonicals.
func (t *tombstoneStore) replace(canonicals [][]byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	encoded := make([]string, len(canonicals))
	for i, c := range canonicals {
		encoded[i] = b64(c)
	}
	return t.save(encoded)
}
