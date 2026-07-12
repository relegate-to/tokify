package sharing

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"testing"

	"github.com/stretchr/testify/require"
)

func newEncKeypair(t *testing.T) ([]byte, []byte) {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	require.NoError(t, err)
	return k.Bytes(), k.PublicKey().Bytes()
}

func TestSealToOpenRoundTrip(t *testing.T) {
	priv, pub := newEncKeypair(t)
	plaintext := []byte("wrapped epoch key material")
	aad := []byte(`{"audience_id":"aud","epoch":3}`)

	wire, err := SealTo(pub, plaintext, aad)
	require.NoError(t, err)
	require.Greater(t, len(wire), keyLen)

	got, err := OpenSealed(priv, wire, aad)
	require.NoError(t, err)
	require.Equal(t, plaintext, got)
}

func TestSealToWrongRecipientFails(t *testing.T) {
	_, pub := newEncKeypair(t)
	otherPriv, _ := newEncKeypair(t)
	aad := []byte("ctx")

	wire, err := SealTo(pub, []byte("secret"), aad)
	require.NoError(t, err)

	_, err = OpenSealed(otherPriv, wire, aad)
	require.Error(t, err)
}

func TestSealToFlippedAADFails(t *testing.T) {
	priv, pub := newEncKeypair(t)
	aad := []byte("original-context")

	wire, err := SealTo(pub, []byte("secret"), aad)
	require.NoError(t, err)

	bad := bytes.Clone(aad)
	bad[0] ^= 0xff
	_, err = OpenSealed(priv, wire, bad)
	require.Error(t, err)
}

func TestSealToTamperedWireFails(t *testing.T) {
	priv, pub := newEncKeypair(t)
	aad := []byte("ctx")

	wire, err := SealTo(pub, []byte("secret payload"), aad)
	require.NoError(t, err)

	// Tamper the ciphertext body.
	tampered := bytes.Clone(wire)
	tampered[len(tampered)-1] ^= 0xff
	_, err = OpenSealed(priv, tampered, aad)
	require.Error(t, err)

	// Tamper the ephemeral public key.
	tamperedEph := bytes.Clone(wire)
	tamperedEph[0] ^= 0xff
	_, err = OpenSealed(priv, tamperedEph, aad)
	require.Error(t, err)

	// Truncated wire.
	_, err = OpenSealed(priv, wire[:keyLen-1], aad)
	require.Error(t, err)
	_, err = OpenSealed(priv, wire[:keyLen], aad)
	require.Error(t, err) // no ciphertext/tag at all
}

func TestSealToNonDeterministic(t *testing.T) {
	_, pub := newEncKeypair(t)
	aad := []byte("ctx")

	w1, err := SealTo(pub, []byte("same"), aad)
	require.NoError(t, err)
	w2, err := SealTo(pub, []byte("same"), aad)
	require.NoError(t, err)

	require.NotEqual(t, w1, w2, "fresh ephemeral key must randomize each seal")
}

func TestSealToRejectsBadPublicKey(t *testing.T) {
	_, err := SealTo([]byte("too short"), []byte("x"), nil)
	require.Error(t, err)
}
