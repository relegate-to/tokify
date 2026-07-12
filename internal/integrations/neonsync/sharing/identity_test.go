package sharing

import (
	"bytes"
	"crypto/rand"
	"testing"

	"github.com/stretchr/testify/require"
)

func newKEK(t *testing.T) []byte {
	t.Helper()
	kek := make([]byte, keyLen)
	_, err := rand.Read(kek)
	require.NoError(t, err)
	return kek
}

func TestWrapUnwrapIdentityRoundTrip(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	kek := newKEK(t)

	ct, nonce, err := WrapIdentity(id, kek, "user-123")
	require.NoError(t, err)
	require.Len(t, nonce, nonceLen)

	got, err := UnwrapIdentity(ct, nonce, kek, "user-123")
	require.NoError(t, err)
	require.Equal(t, id.EncPriv.Bytes(), got.EncPriv.Bytes())
	require.True(t, bytes.Equal(id.SigPriv, got.SigPriv))
	require.Equal(t, id.Public().EncPub, got.Public().EncPub)
}

func TestUnwrapIdentityWrongKEKFails(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	kek := newKEK(t)
	ct, nonce, err := WrapIdentity(id, kek, "user-123")
	require.NoError(t, err)

	_, err = UnwrapIdentity(ct, nonce, newKEK(t), "user-123")
	require.Error(t, err)
}

func TestUnwrapIdentityWrongUserIDFails(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	kek := newKEK(t)
	ct, nonce, err := WrapIdentity(id, kek, "user-123")
	require.NoError(t, err)

	_, err = UnwrapIdentity(ct, nonce, kek, "user-456")
	require.Error(t, err)
}

func TestWrapIdentityRejectsBadKEKLength(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	_, _, err = WrapIdentity(id, []byte("short"), "u")
	require.Error(t, err)
}

func TestFingerprintDeterministic(t *testing.T) {
	id, err := GenerateIdentity()
	require.NoError(t, err)
	pub := id.Public()
	fp := Fingerprint(pub)
	require.Equal(t, fp, Fingerprint(id.Public()))

	other, err := GenerateIdentity()
	require.NoError(t, err)
	require.NotEqual(t, Fingerprint(pub), Fingerprint(other.Public()))
}

// TestFingerprintGolden freezes the fingerprint format against a fixed input.
// SHA-256("enc"||"sig") rendered as 8 groups of 4 lowercase hex. If this test
// fails, the fingerprint format changed and every user's out-of-band
// verification value silently broke.
func TestFingerprintGolden(t *testing.T) {
	pub := PublicIdentity{EncPub: []byte("enc"), SigPub: []byte("sig")}
	// SHA-256("encsig") = 37436a2eef567ec59a577c2c09c707955540ad5f2bdae614939fbbcd16d87e53
	require.Equal(t, "3743 6a2e ef56 7ec5 9a57 7c2c 09c7 0795", Fingerprint(pub))
}
