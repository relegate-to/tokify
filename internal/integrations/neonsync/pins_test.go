package neonsync

import (
	"path/filepath"
	"testing"
)

func newTestPins(t *testing.T) *PinStore {
	t.Helper()
	return newPinStore(filepath.Join(t.TempDir(), "neonsync.json"))
}

func TestPinTOFUAndVerify(t *testing.T) {
	p := newTestPins(t)

	// First observation trusts on first use.
	if err := p.Pin("alice", "fp-alice"); err != nil {
		t.Fatal(err)
	}
	ok, err := p.Verify("alice", "fp-alice")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("pinned fingerprint should verify")
	}

	// An unpinned user does not verify.
	ok, _ = p.Verify("bob", "fp-bob")
	if ok {
		t.Fatal("unpinned user must not verify")
	}

	// A mismatched fingerprint for a pinned user does not verify.
	ok, _ = p.Verify("alice", "fp-evil")
	if ok {
		t.Fatal("swapped fingerprint must not verify")
	}
}

func TestPinConflictRejected(t *testing.T) {
	p := newTestPins(t)
	if err := p.Pin("alice", "fp-alice"); err != nil {
		t.Fatal(err)
	}
	// Re-pinning the SAME fingerprint is idempotent.
	if err := p.Pin("alice", "fp-alice"); err != nil {
		t.Fatal("re-pinning same fingerprint should be a no-op, not an error")
	}
	// Re-pinning a DIFFERENT fingerprint is the key-swap attack: rejected.
	if err := p.Pin("alice", "fp-different"); err == nil {
		t.Fatal("re-pinning a different fingerprint must be rejected")
	}
	// Explicit unpin (rotation) then re-pin succeeds.
	if err := p.Unpin("alice"); err != nil {
		t.Fatal(err)
	}
	if err := p.Pin("alice", "fp-different"); err != nil {
		t.Fatal("re-pin after unpin should succeed")
	}
}

func TestEpochWatermark(t *testing.T) {
	p := newTestPins(t)

	// First observation records the mark and passes.
	if err := p.CheckEpochWatermark("aud", 3); err != nil {
		t.Fatal(err)
	}
	if wm, _ := p.EpochWatermark("aud"); wm != 3 {
		t.Fatalf("watermark = %d, want 3", wm)
	}

	// Growing (an epoch bump) advances the mark.
	if err := p.CheckEpochWatermark("aud", 5); err != nil {
		t.Fatal(err)
	}
	if wm, _ := p.EpochWatermark("aud"); wm != 5 {
		t.Fatalf("watermark = %d, want 5", wm)
	}

	// A server presenting FEWER epochs than seen before is a truncation: hard error.
	if err := p.CheckEpochWatermark("aud", 4); err == nil {
		t.Fatal("truncated epoch history must be rejected")
	}

	// Re-presenting the same count is fine.
	if err := p.CheckEpochWatermark("aud", 5); err != nil {
		t.Fatal("re-observing the high-water count should be accepted")
	}

	// Watermarks are per-audience.
	if err := p.CheckEpochWatermark("other", 1); err != nil {
		t.Fatal(err)
	}
}

func TestPinsPersistAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "neonsync.json")

	p1 := newPinStore(path)
	if err := p1.Pin("alice", "fp-alice"); err != nil {
		t.Fatal(err)
	}
	if err := p1.CheckEpochWatermark("aud", 2); err != nil {
		t.Fatal(err)
	}

	// A fresh store over the same file sees the persisted pins + watermark.
	p2 := newPinStore(path)
	ok, _ := p2.Verify("alice", "fp-alice")
	if !ok {
		t.Fatal("pin did not persist across instances")
	}
	if wm, _ := p2.EpochWatermark("aud"); wm != 2 {
		t.Fatalf("watermark did not persist: %d", wm)
	}
}
