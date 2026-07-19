package neonsync

import (
	"path/filepath"
	"testing"

	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
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

func TestMergeRemoteSeedsAndPreservesLocal(t *testing.T) {
	// A fresh device (empty local store) inherits another device's pins wholesale.
	device1 := newTestPins(t)
	if err := device1.Pin("alice", "fp-alice"); err != nil {
		t.Fatal(err)
	}
	if err := device1.Pin("bob", "fp-bob"); err != nil {
		t.Fatal(err)
	}
	if err := device1.CheckEpochWatermark("aud", 4); err != nil {
		t.Fatal(err)
	}
	blob, exportErr := device1.Export()
	if exportErr != nil {
		t.Fatal(exportErr)
	}

	device2 := newTestPins(t)
	if mergeErr := device2.MergeRemote(blob); mergeErr != nil {
		t.Fatal(mergeErr)
	}
	if ok, _ := device2.Verify("alice", "fp-alice"); !ok {
		t.Fatal("merge should seed alice's pin")
	}
	if ok, _ := device2.Verify("bob", "fp-bob"); !ok {
		t.Fatal("merge should seed bob's pin")
	}
	if wm, _ := device2.EpochWatermark("aud"); wm != 4 {
		t.Fatalf("merge should carry the watermark: got %d", wm)
	}

	// A conflicting remote fingerprint never overwrites a locally pinned one, and
	// the watermark only ratchets up (a lower remote count is ignored).
	device2Local := newTestPins(t)
	if pinErr := device2Local.Pin("alice", "fp-alice-local"); pinErr != nil {
		t.Fatal(pinErr)
	}
	if watermarkErr := device2Local.CheckEpochWatermark("aud", 9); watermarkErr != nil {
		t.Fatal(watermarkErr)
	}
	if mergeErr := device2Local.MergeRemote(blob); mergeErr != nil {
		t.Fatal(mergeErr)
	}
	if ok, _ := device2Local.Verify("alice", "fp-alice-local"); !ok {
		t.Fatal("local pin must win a conflict, not be overwritten by remote")
	}
	if ok, _ := device2Local.Verify("bob", "fp-bob"); !ok {
		t.Fatal("non-conflicting remote pin should still be merged in")
	}
	if wm, _ := device2Local.EpochWatermark("aud"); wm != 9 {
		t.Fatalf("watermark must not regress below local: got %d", wm)
	}
}

func TestWrapPinsRoundTrip(t *testing.T) {
	device1 := newTestPins(t)
	if err := device1.Pin("alice", "fp-alice"); err != nil {
		t.Fatal(err)
	}
	blob, exportErr := device1.Export()
	if exportErr != nil {
		t.Fatal(exportErr)
	}

	dek := make([]byte, 32)
	for i := range dek {
		dek[i] = byte(i)
	}
	ct, nonce, wrapErr := sharing.WrapPins(blob, dek, "user-1")
	if wrapErr != nil {
		t.Fatal(wrapErr)
	}

	// Correct DEK + user id round-trips.
	got, unwrapErr := sharing.UnwrapPins(ct, nonce, dek, "user-1")
	if unwrapErr != nil {
		t.Fatal(unwrapErr)
	}
	device2 := newTestPins(t)
	if mergeErr := device2.MergeRemote(got); mergeErr != nil {
		t.Fatal(mergeErr)
	}
	if ok, _ := device2.Verify("alice", "fp-alice"); !ok {
		t.Fatal("round-tripped pins should verify after merge")
	}

	// A different user id in the AAD fails authentication (no cross-account splice).
	if _, crossAccountErr := sharing.UnwrapPins(ct, nonce, dek, "user-2"); crossAccountErr == nil {
		t.Fatal("unwrap under a different user id must fail")
	}
	// A wrong DEK fails authentication.
	wrong := make([]byte, 32)
	if _, wrongKeyErr := sharing.UnwrapPins(ct, nonce, wrong, "user-1"); wrongKeyErr == nil {
		t.Fatal("unwrap under a wrong DEK must fail")
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
