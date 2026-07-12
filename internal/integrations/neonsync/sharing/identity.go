package sharing

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"strings"

	"github.com/go-faster/errors"
	"golang.org/x/crypto/chacha20poly1305"
)

// Identity is a member's long-term keypair (plan §2, §2a): an X25519 half for
// receiving sealed keys and an Ed25519 half for signing what the member
// authors. The two halves are minted and stored together; the signing half is
// what makes an author's entries and an admin's epoch announcements
// unforgeable, not merely confidential.
type Identity struct {
	EncPriv *ecdh.PrivateKey
	SigPriv ed25519.PrivateKey
}

// PublicIdentity is the shareable half of an Identity, and the object that
// out-of-band fingerprint verification (plan §9) pins.
type PublicIdentity struct {
	EncPub []byte
	SigPub ed25519.PublicKey
}

// wrappedIdentity is the fixed-field serialization of both private keys, sealed
// under the password-derived KEK. Base64 fields so it survives JSON transport
// unchanged, matching neonsync.
type wrappedIdentity struct {
	EncPriv string `json:"enc_priv"`
	SigPriv string `json:"sig_priv"`
}

// identityAAD binds the wrapped identity to its owning user so the server cannot
// hand user A's wrapped identity to user B's unwrap path and have it succeed.
type identityAAD struct {
	UserID string `json:"user_id"`
}

// GenerateIdentity mints a fresh X25519 + Ed25519 identity.
func GenerateIdentity() (*Identity, error) {
	encPriv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.Wrap(err, "generate x25519")
	}
	_, sigPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.Wrap(err, "generate ed25519")
	}
	return &Identity{EncPriv: encPriv, SigPriv: sigPriv}, nil
}

// Public returns the shareable public halves.
func (id *Identity) Public() PublicIdentity {
	sigPub, _ := id.SigPriv.Public().(ed25519.PublicKey)
	return PublicIdentity{
		EncPub: id.EncPriv.PublicKey().Bytes(),
		SigPub: sigPub,
	}
}

// WrapIdentity seals both private keys under the caller-derived 32-byte KEK
// (see neonsync.DeriveKEK) with the user id bound as AAD, returning the
// ciphertext and its detached random nonce (matching neonsync's seal pattern so
// the two columns store cleanly). This is the level-4 wrap of plan §2: the
// member's identity private key wrapped by their password-derived key.
func WrapIdentity(id *Identity, kek []byte, userID string) ([]byte, []byte, error) {
	if len(kek) != keyLen {
		return nil, nil, errors.Errorf("kek length = %d, want %d", len(kek), keyLen)
	}
	blob, err := marshalCanonical(wrappedIdentity{
		EncPriv: b64(id.EncPriv.Bytes()),
		SigPriv: b64(id.SigPriv),
	})
	if err != nil {
		return nil, nil, err
	}
	aad, err := identityWrapAAD(userID)
	if err != nil {
		return nil, nil, err
	}

	aead, err := chacha20poly1305.NewX(kek)
	if err != nil {
		return nil, nil, errors.Wrap(err, "new aead")
	}
	nonce, err := randomBytes(nonceLen)
	if err != nil {
		return nil, nil, err
	}
	return aead.Seal(nil, nonce, blob, aad), nonce, nil
}

// UnwrapIdentity recovers an Identity from its wrapped form. A wrong KEK (wrong
// password) or a mismatched userID (spliced-in blob) both fail as an
// authentication error rather than returning garbage keys.
func UnwrapIdentity(ciphertext, nonce, kek []byte, userID string) (*Identity, error) {
	if len(kek) != keyLen {
		return nil, errors.Errorf("kek length = %d, want %d", len(kek), keyLen)
	}
	if len(nonce) != nonceLen {
		return nil, errors.New("wrong nonce size")
	}
	aad, err := identityWrapAAD(userID)
	if err != nil {
		return nil, err
	}

	aead, err := chacha20poly1305.NewX(kek)
	if err != nil {
		return nil, errors.Wrap(err, "new aead")
	}
	blob, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.Wrap(err, "unwrap identity")
	}

	var w wrappedIdentity
	if uerr := jsonUnmarshal(blob, &w); uerr != nil {
		return nil, uerr
	}
	encRaw, err := unb64(w.EncPriv)
	if err != nil {
		return nil, err
	}
	sigRaw, err := unb64(w.SigPriv)
	if err != nil {
		return nil, err
	}
	encPriv, err := ecdh.X25519().NewPrivateKey(encRaw)
	if err != nil {
		return nil, errors.Wrap(err, "enc private key")
	}
	if len(sigRaw) != ed25519.PrivateKeySize {
		return nil, errors.New("sig private key wrong size")
	}
	return &Identity{EncPriv: encPriv, SigPriv: ed25519.PrivateKey(sigRaw)}, nil
}

// identityWrapAAD is the canonical AAD for identity wrapping: {"user_id": ...}.
// Domain context (domainIdentity) is not folded in because the user id alone is
// the binding the plan asks for; the constant exists for callers that want to
// namespace their own derivations.
func identityWrapAAD(userID string) ([]byte, error) {
	return marshalCanonical(identityAAD{UserID: userID})
}

// Fingerprint renders a stable, human-comparable string over
// SHA-256(encPub || sigPub) as 8 groups of 4 lowercase hex digits separated by
// spaces (the leading 16 bytes of the digest). This is the out-of-band
// verification value of plan §9 — the crown-jewel trust root that both
// member-key and epoch-key verification chain back to. The format and the
// input ordering (enc then sig) are FROZEN: changing either changes every
// user's fingerprint and silently breaks prior out-of-band comparisons.
func Fingerprint(pub PublicIdentity) string {
	h := sha256.New()
	h.Write(pub.EncPub)
	h.Write(pub.SigPub)
	sum := h.Sum(nil)

	const groups, groupLen = 8, 2 // 8 groups x 2 bytes = 4 hex chars each
	parts := make([]string, groups)
	for i := range groups {
		chunk := sum[i*groupLen : i*groupLen+groupLen]
		parts[i] = hexChunk(chunk)
	}
	return strings.Join(parts, " ")
}

const hexDigits = "0123456789abcdef"

func hexChunk(b []byte) string {
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexDigits[c>>4]
		out[i*2+1] = hexDigits[c&0x0f]
	}
	return string(out)
}
