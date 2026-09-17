package neonsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"

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
// local activity store does not already hold in the clear.
//
// The desktop app and its MCP server (a separate process) both write here, so
// every mutation holds an flock on a sidecar file and re-reads under it, and
// pruning filters the current contents rather than writing back a snapshot a
// concurrent add would be lost from.
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

// withLock runs fn while holding both the in-process mutex and the cross-process
// file lock.
func (t *tombstoneStore) withLock(fn func() error) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(t.path), 0o700); err != nil {
		return errors.Wrap(err, "ensure tombstones dir")
	}
	lock, err := os.OpenFile(t.path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return errors.Wrap(err, "open tombstones lock")
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return errors.Wrap(err, "lock tombstones")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck // closing the fd releases it anyway
	return fn()
}

// load reads the persisted base64 canonicals. Caller must hold the lock.
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

// save rewrites the file atomically so a reader never sees a partial write.
// Caller must hold the lock.
func (t *tombstoneStore) save(encoded []string) error {
	data, err := json.MarshalIndent(tombstoneFile{Deleted: encoded}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "marshal tombstones")
	}
	tmp := t.path + ".tmp"
	if werr := os.WriteFile(tmp, data, 0o600); werr != nil {
		return errors.Wrap(werr, "write tombstones")
	}
	if rerr := os.Rename(tmp, t.path); rerr != nil {
		return errors.Wrap(rerr, "replace tombstones")
	}
	return nil
}

// add records one canonical-bytes tombstone, de-duplicating.
func (t *tombstoneStore) add(canonical []byte) error {
	return t.withLock(func() error {
		encoded, err := t.load()
		if err != nil {
			return err
		}
		enc := b64(canonical)
		if slices.Contains(encoded, enc) {
			return nil
		}
		return t.save(append(encoded, enc))
	})
}

// all returns the tombstoned entries as canonical byte slices.
func (t *tombstoneStore) all() ([][]byte, error) {
	var out [][]byte
	err := t.withLock(func() error {
		encoded, err := t.load()
		if err != nil {
			return err
		}
		out = make([][]byte, 0, len(encoded))
		for _, e := range encoded {
			raw, derr := unb64(e)
			if derr != nil {
				continue // a corrupt entry can't be matched anyway; drop it
			}
			out = append(out, raw)
		}
		return nil
	})
	return out, err
}

// retain drops every tombstone for which keep returns false, evaluated against
// the file's contents at the time of the call so tombstones added since the
// caller last read are judged too, never silently overwritten.
func (t *tombstoneStore) retain(keep func(canonical []byte) bool) error {
	return t.withLock(func() error {
		encoded, err := t.load()
		if err != nil {
			return err
		}
		kept := make([]string, 0, len(encoded))
		for _, e := range encoded {
			raw, derr := unb64(e)
			if derr != nil || !keep(raw) {
				continue
			}
			kept = append(kept, e)
		}
		if len(kept) == len(encoded) {
			return nil
		}
		return t.save(kept)
	})
}
