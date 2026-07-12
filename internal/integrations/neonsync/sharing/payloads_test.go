package sharing

import (
	"bytes"
	"crypto/rand"
	"testing"

	"github.com/stretchr/testify/require"
)

func newDEK(t *testing.T) []byte {
	t.Helper()
	dek := make([]byte, keyLen)
	_, err := rand.Read(dek)
	require.NoError(t, err)
	return dek
}

func TestEntryPayloadRoundTrip(t *testing.T) {
	dek := newDEK(t)
	aad := EntryAAD{EntryID: "e1", Version: 1, AuthorID: "author"}
	plaintext := []byte(`{"description":"write tests"}`)

	ct, nonce, err := EncryptEntryPayload(dek, plaintext, aad)
	require.NoError(t, err)
	require.NotContains(t, string(ct), "write tests")

	got, err := DecryptEntryPayload(dek, ct, nonce, aad)
	require.NoError(t, err)
	require.Equal(t, plaintext, got)
}

func TestEntryPayloadWrongVersionFails(t *testing.T) {
	dek := newDEK(t)
	aad := EntryAAD{EntryID: "e1", Version: 1, AuthorID: "author"}
	ct, nonce, err := EncryptEntryPayload(dek, []byte("secret"), aad)
	require.NoError(t, err)

	wrong := aad
	wrong.Version = 2
	_, err = DecryptEntryPayload(dek, ct, nonce, wrong)
	require.Error(t, err)
}

func TestEntryPayloadWrongAuthorFails(t *testing.T) {
	dek := newDEK(t)
	aad := EntryAAD{EntryID: "e1", Version: 1, AuthorID: "author"}
	ct, nonce, err := EncryptEntryPayload(dek, []byte("secret"), aad)
	require.NoError(t, err)

	wrong := aad
	wrong.AuthorID = "impostor"
	_, err = DecryptEntryPayload(dek, ct, nonce, wrong)
	require.Error(t, err)
}

func TestEntryPayloadWrongNonceSize(t *testing.T) {
	dek := newDEK(t)
	aad := EntryAAD{EntryID: "e1", Version: 1, AuthorID: "author"}
	ct, nonce, err := EncryptEntryPayload(dek, []byte("secret"), aad)
	require.NoError(t, err)
	_, err = DecryptEntryPayload(dek, ct, nonce[:8], aad)
	require.Error(t, err)
}

func TestDeriveEntryDEKDeterministicAndDistinct(t *testing.T) {
	account := newDEK(t)

	a1, err := DeriveEntryDEK(account, "entry-a")
	require.NoError(t, err)
	a2, err := DeriveEntryDEK(account, "entry-a")
	require.NoError(t, err)
	require.True(t, bytes.Equal(a1, a2), "same account DEK + id must derive same key")
	require.Len(t, a1, keyLen)

	b, err := DeriveEntryDEK(account, "entry-b")
	require.NoError(t, err)
	require.False(t, bytes.Equal(a1, b), "different ids must derive different keys")

	other := newDEK(t)
	c, err := DeriveEntryDEK(other, "entry-a")
	require.NoError(t, err)
	require.False(t, bytes.Equal(a1, c), "different account DEK must derive different keys")
}

func TestEntrySignatureRoundTrip(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	aad := EntryAAD{EntryID: "e1", Version: 3, AuthorID: "author"}
	ciphertext := []byte("some ciphertext bytes")

	sig, err := SignEntry(id.SigPriv, aad, ciphertext)
	require.NoError(t, err)

	ok, err := VerifyEntrySig(id.Public().SigPub, aad, ciphertext, sig)
	require.NoError(t, err)
	require.True(t, ok)

	// Tampered ciphertext fails.
	ok, err = VerifyEntrySig(id.Public().SigPub, aad, []byte("other"), sig)
	require.NoError(t, err)
	require.False(t, ok)

	// Tampered metadata fails.
	wrong := aad
	wrong.Version = 4
	ok, err = VerifyEntrySig(id.Public().SigPub, wrong, ciphertext, sig)
	require.NoError(t, err)
	require.False(t, ok)

	// Wrong signer fails.
	other, err := GenerateIdentity()
	require.NoError(t, err)
	ok, err = VerifyEntrySig(other.Public().SigPub, aad, ciphertext, sig)
	require.NoError(t, err)
	require.False(t, ok)
}

func TestGrantSignatureRoundTrip(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	aad := GrantAAD{EntryID: "e1", AudienceID: "aud", Epoch: 2}
	wrapped := []byte("sealed dek wire")

	sig, err := SignGrant(id.SigPriv, aad, wrapped)
	require.NoError(t, err)

	ok, err := VerifyGrantSig(id.Public().SigPub, aad, wrapped, sig)
	require.NoError(t, err)
	require.True(t, ok)

	wrong := aad
	wrong.Epoch = 3
	ok, err = VerifyGrantSig(id.Public().SigPub, wrong, wrapped, sig)
	require.NoError(t, err)
	require.False(t, ok)
}

// TestEntrySigDomainSeparation ensures an entry signature cannot be replayed as
// a grant signature and vice versa, even if the canonical payloads collided.
func TestSigDomainSeparation(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)

	entryAAD := EntryAAD{EntryID: "x", Version: 1, AuthorID: "a"}
	sig, err := SignEntry(id.SigPriv, entryAAD, []byte("ct"))
	require.NoError(t, err)

	// The same bytes must not verify under the grant helper/domain.
	grantAAD := GrantAAD{EntryID: "x", AudienceID: "a", Epoch: 1}
	ok, err := VerifyGrantSig(id.Public().SigPub, grantAAD, []byte("ct"), sig)
	require.NoError(t, err)
	require.False(t, ok)
}
