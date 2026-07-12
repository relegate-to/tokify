package neonsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/go-faster/errors"
)

// PinStore is the out-of-band trust root the whole E2EE guarantee rests on (plan
// §9). It records two independent facts, both of which RLS cannot enforce and
// the server must never be trusted to supply:
//
//   - Identity fingerprint pins: the verified fingerprint of each member/admin
//     identity we are willing to wrap epoch keys to or accept authored data from.
//     A pubkey whose fingerprint is not pinned is untrusted transport (§2b/§9),
//     and any operation that would trust it is a hard failure.
//   - Per-audience epoch high-watermark: the highest epoch number ever observed
//     for an audience. The signed prev_epoch hash chain detects a forked or
//     rewritten history, but it cannot by itself detect a server that simply
//     presents FEWER epochs than it once did (truncating the tail): a short
//     prefix 1..k of a valid chain is itself a valid chain. The watermark closes
//     that gap — seeing fewer epochs than the recorded high-water mark is a hard
//     stop.
//
// Persisted as plaintext JSON alongside neonsync.json, following the
// tombstoneStore pattern. It holds only public fingerprints and epoch counts —
// nothing secret — so plaintext at rest exposes nothing the sharing graph on the
// server does not already reveal.
type PinStore struct {
	path string
	mu   sync.Mutex
}

func newPinStore(settingsPath string) *PinStore {
	return &PinStore{path: filepath.Join(filepath.Dir(settingsPath), "neonsync-pins.json")}
}

type pinFile struct {
	// Fingerprints maps a user id to their pinned identity fingerprint (the
	// value Fingerprint() renders). A mismatch on re-observation is a swapped key.
	Fingerprints map[string]string `json:"fingerprints"`
	// Epochs maps an audience id to the highest epoch count ever seen for it.
	Epochs map[string]int `json:"epochs"`
}

// load reads the persisted pins. Caller must hold p.mu.
func (p *PinStore) load() (pinFile, error) {
	data, err := os.ReadFile(p.path)
	if err != nil {
		if os.IsNotExist(err) {
			return pinFile{Fingerprints: map[string]string{}, Epochs: map[string]int{}}, nil
		}
		return pinFile{}, errors.Wrap(err, "read pins")
	}
	var f pinFile
	if uerr := json.Unmarshal(data, &f); uerr != nil {
		return pinFile{}, errors.Wrap(uerr, "unmarshal pins")
	}
	if f.Fingerprints == nil {
		f.Fingerprints = map[string]string{}
	}
	if f.Epochs == nil {
		f.Epochs = map[string]int{}
	}
	return f, nil
}

// save rewrites the file. Caller must hold p.mu.
func (p *PinStore) save(f pinFile) error {
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return errors.Wrap(err, "ensure pins dir")
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return errors.Wrap(err, "marshal pins")
	}
	if werr := os.WriteFile(p.path, data, 0o600); werr != nil {
		return errors.Wrap(werr, "write pins")
	}
	return nil
}

// Pin records (or, deliberately, does NOT overwrite) a user's verified
// fingerprint. First observation trusts-on-first-use; a later call with a
// DIFFERENT fingerprint for the same user is a conflict and is rejected, because
// silently accepting the new value would be exactly the key-swap attack the pin
// exists to catch. Rotation is an explicit re-pin via Unpin, not an overwrite.
func (p *PinStore) Pin(userID, fingerprint string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.load()
	if err != nil {
		return err
	}
	if existing, ok := f.Fingerprints[userID]; ok {
		if existing != fingerprint {
			return errors.Errorf("pin conflict for %s: pinned fingerprint does not match", userID)
		}
		return nil
	}
	f.Fingerprints[userID] = fingerprint
	return p.save(f)
}

// Unpin removes a user's pin, allowing a subsequent Pin to record a new
// fingerprint (identity-key rotation / device-compromise response, plan §9).
func (p *PinStore) Unpin(userID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.load()
	if err != nil {
		return err
	}
	if _, ok := f.Fingerprints[userID]; !ok {
		return nil
	}
	delete(f.Fingerprints, userID)
	return p.save(f)
}

// Verify reports whether the given fingerprint is the one pinned for userID. An
// unpinned user, or a fingerprint mismatch, both return false — the caller must
// treat either as a hard failure (never wrap to / accept from an unverified key).
func (p *PinStore) Verify(userID, fingerprint string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.load()
	if err != nil {
		return false, err
	}
	pinned, ok := f.Fingerprints[userID]
	return ok && pinned == fingerprint, nil
}

// Fingerprint returns the pinned fingerprint for userID, or ("", false) when the
// user is not pinned.
func (p *PinStore) Fingerprint(userID string) (string, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.load()
	if err != nil {
		return "", false, err
	}
	fp, ok := f.Fingerprints[userID]
	return fp, ok, nil
}

// CheckEpochWatermark validates an observed epoch count for an audience against
// the recorded high-water mark and advances the mark when the count grows. An
// observed count LOWER than the recorded mark means the server presented a
// truncated epoch history and is a hard error. The count is normally the length
// of the full 1..N chain fetched on reconcile.
func (p *PinStore) CheckEpochWatermark(audienceID string, observed int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.load()
	if err != nil {
		return err
	}
	if prev, ok := f.Epochs[audienceID]; ok && observed < prev {
		return errors.Errorf("audience %s: epoch history truncated (saw %d, expected at least %d)", audienceID, observed, prev)
	}
	if f.Epochs[audienceID] < observed {
		f.Epochs[audienceID] = observed
		return p.save(f)
	}
	return nil
}

// EpochWatermark returns the recorded high-water mark for an audience (0 if
// never seen).
func (p *PinStore) EpochWatermark(audienceID string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.load()
	if err != nil {
		return 0, err
	}
	return f.Epochs[audienceID], nil
}
