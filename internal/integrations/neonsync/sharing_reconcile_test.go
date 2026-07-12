package neonsync

import (
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// TestV2OwnRoundTrip proves the v2 own-entry encode/decode path is self-
// consistent: an entry encrypted with the per-entry derived DEK + EntryAAD by
// the push path is recovered by decodeV2OwnRow, and the legacy fallback is NOT
// used for it (a legacy decode of a v2 row must fail).
func TestV2OwnRoundTrip(t *testing.T) {
	dek, _ := GenerateDEK()
	ownerID := "user-sub-123"
	start := time.Date(2026, 7, 12, 9, 30, 0, 0, time.Local)
	end := start.Add(45 * time.Minute)
	a := act("tokify", start)
	a.EndTime = &end
	a.Description = "write ops layer"

	canonical := canonicalize(a)
	id := EntryID(dek, canonical)

	entryDEK, err := sharing.DeriveEntryDEK(dek, id)
	if err != nil {
		t.Fatal(err)
	}
	aad := sharing.EntryAAD{EntryID: id, Version: entryVersion, AuthorID: ownerID}
	ct, nonce, err := sharing.EncryptEntryPayload(entryDEK, canonical, aad)
	if err != nil {
		t.Fatal(err)
	}
	row := entryRow{ID: id, Ciphertext: b64(ct), Nonce: b64(nonce)}

	got, err := decodeV2OwnRow(dek, ownerID, row)
	if err != nil {
		t.Fatal(err)
	}
	if got.Description != a.Description || got.Project != a.Project {
		t.Fatalf("v2 round-trip mismatch: %+v", got)
	}
	if !got.StartTime.Equal(a.StartTime) {
		t.Fatalf("start mismatch: %v vs %v", got.StartTime, a.StartTime)
	}

	// A wrong owner in the AAD (server mis-attributing authorship) fails.
	if _, derr := decodeV2OwnRow(dek, "someone-else", row); derr == nil {
		t.Fatal("v2 decode with wrong owner AAD must fail")
	}

	// The legacy account-DEK decode must NOT open a v2 row.
	if _, derr := decodeRow(dek, row); derr == nil {
		t.Fatal("legacy decode should not open a v2 (AAD-bound, derived-DEK) row")
	}
}

func TestGrantLive(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)

	// No upper bound and not revoked -> live.
	if !grantLive(grantRow{}, now) {
		t.Fatal("unbounded, unrevoked grant should be live")
	}

	// Revoked -> not live.
	if grantLive(grantRow{Revoked: true}, now) {
		t.Fatal("revoked grant must not be live")
	}

	// Past valid_until -> not live.
	past := now.Add(-time.Hour).Format(time.RFC3339)
	if grantLive(grantRow{ValidUntil: &past}, now) {
		t.Fatal("expired grant must not be live")
	}

	// Future valid_until -> live.
	future := now.Add(time.Hour).Format(time.RFC3339)
	if !grantLive(grantRow{ValidUntil: &future}, now) {
		t.Fatal("grant with a future valid_until should be live")
	}
}
