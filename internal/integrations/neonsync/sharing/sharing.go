package sharing

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"

	"github.com/go-faster/errors"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

// Domain-separation constants. Every Ed25519 signature is computed over
// []byte(domain) || '\n' || canonicalJSON, and the seal construction feeds its
// domain into HKDF. Versioned so a future scheme can coexist; frozen once any
// signed/sealed data exists on a server — changing one invalidates every value
// produced under it. These strings are part of the fixed wire contract.
const (
	domainEntry    = "tokify-share-entry-v1"    // entry signature
	domainGrant    = "tokify-share-grant-v1"    // grant signature
	domainEpoch    = "tokify-share-epoch-v1"    // epoch announcement signature
	domainSeal     = "tokify-share-seal-v1"     // HKDF info for the sealed-box construction
	domainEntryDEK = "tokify-entry-dek-v1"      // per-entry DEK derivation info prefix
	domainIdentity = "tokify-share-identity-v1" // AAD context for identity wrapping
)

const (
	// keyLen is the byte length of every symmetric key and X25519 scalar here,
	// matching XChaCha20-Poly1305's 32-byte key and Curve25519's 32-byte point.
	keyLen = 32

	// nonceLen is XChaCha20-Poly1305's 24-byte nonce.
	nonceLen = chacha20poly1305.NonceSizeX
)

// sealedBoxKeyLen documents that the sealed-box KDF emits a full AEAD key.
const sealedBoxKeyLen = 32

// SealTo is an HPKE-style, AAD-binding sealed box: it encrypts plaintext to a
// recipient's X25519 public key such that only that recipient can open it, and
// binds the caller's AAD into the AEAD (plan §2a requires context binding on
// every wrap).
//
// libsodium's crypto_box_seal has no AAD slot, so it cannot bind a ciphertext
// to its database row; a malicious server could splice a validly-sealed DEK
// under a different (entry_id, audience_id, epoch) and the recipient would open
// it against the wrong context without noticing. This construction exists to
// close that hole: the AAD travels through the AEAD, so wrong-context opens
// fail as authentication errors.
//
// Wire format: ephPub(32) || ciphertext. The ciphertext carries its own
// Poly1305 tag, so a truncated or flipped wire fails to open.
//
// The 24-byte nonce is all-zero, which is safe here precisely because the key
// is single-use: a fresh ephemeral keypair is minted per call, so the HKDF
// output key never repeats across seals, and nonce-reuse only breaks AEAD when
// the same key is reused. Same rationale as HPKE / crypto_box_seal.
func SealTo(recipientEncPub, plaintext, aad []byte) ([]byte, error) {
	recipient, err := ecdh.X25519().NewPublicKey(recipientEncPub)
	if err != nil {
		return nil, errors.Wrap(err, "recipient public key")
	}

	ephPriv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.Wrap(err, "ephemeral key")
	}
	ephPub := ephPriv.PublicKey().Bytes()

	shared, err := ephPriv.ECDH(recipient)
	if err != nil {
		return nil, errors.Wrap(err, "ecdh")
	}
	// crypto/ecdh already rejects low-order points that yield the all-zero shared
	// secret, but check explicitly: an all-zero secret means a contributory
	// keyshare failure and must never be fed to the KDF.
	if isAllZero(shared) {
		return nil, errors.New("degenerate shared secret")
	}

	key, err := sealKey(shared, ephPub, recipientEncPub)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, errors.Wrap(err, "new aead")
	}

	zeroNonce := make([]byte, nonceLen)
	ciphertext := aead.Seal(nil, zeroNonce, plaintext, aad)

	wire := make([]byte, 0, len(ephPub)+len(ciphertext))
	wire = append(wire, ephPub...)
	wire = append(wire, ciphertext...)
	return wire, nil
}

// OpenSealed reverses SealTo. A wrong recipient key, a flipped AAD byte, or any
// tamper of the wire surfaces identically as an AEAD open failure — never a
// silent wrong answer (plan §2a).
func OpenSealed(recipientEncPriv, wire, aad []byte) ([]byte, error) {
	if len(wire) < keyLen {
		return nil, errors.New("sealed wire too short")
	}
	ephPub := wire[:keyLen]
	ciphertext := wire[keyLen:]

	priv, err := ecdh.X25519().NewPrivateKey(recipientEncPriv)
	if err != nil {
		return nil, errors.Wrap(err, "recipient private key")
	}
	eph, err := ecdh.X25519().NewPublicKey(ephPub)
	if err != nil {
		return nil, errors.Wrap(err, "ephemeral public key")
	}

	shared, err := priv.ECDH(eph)
	if err != nil {
		return nil, errors.Wrap(err, "ecdh")
	}
	if isAllZero(shared) {
		return nil, errors.New("degenerate shared secret")
	}

	// salt = ephPub || recipientPub, reconstructed from our own public half so a
	// spliced ephemeral key cannot collide the KDF salt with the sealer's.
	key, err := sealKey(shared, ephPub, priv.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, errors.Wrap(err, "new aead")
	}

	zeroNonce := make([]byte, nonceLen)
	plaintext, err := aead.Open(nil, zeroNonce, ciphertext, aad)
	if err != nil {
		return nil, errors.Wrap(err, "open sealed")
	}
	return plaintext, nil
}

// sealKey derives the single-use AEAD key for a sealed box. Salting HKDF with
// both public keys binds the derived key to this exact (ephemeral, recipient)
// pair, matching the HPKE DHKEM shape.
func sealKey(shared, ephPub, recipientPub []byte) ([]byte, error) {
	salt := make([]byte, 0, len(ephPub)+len(recipientPub))
	salt = append(salt, ephPub...)
	salt = append(salt, recipientPub...)
	r := hkdf.New(sha256.New, shared, salt, []byte(domainSeal))
	key := make([]byte, sealedBoxKeyLen)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, errors.Wrap(err, "hkdf seal key")
	}
	return key, nil
}

func isAllZero(b []byte) bool {
	return subtle.ConstantTimeCompare(b, make([]byte, len(b))) == 1
}

// b64 and unb64 wrap the standard base64 used for every binary field that lands
// in a DB text column, matching the existing neonsync crypto.
func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func unb64(s string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, errors.Wrap(err, "base64 decode")
	}
	return b, nil
}

func hexHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, errors.Wrap(err, "read random")
	}
	return b, nil
}

// signPayload signs domain || '\n' || canonical with an Ed25519 private key.
// The domain prefix means a signature minted for one purpose (say an entry) can
// never be replayed as a signature for another (a grant), even if the canonical
// bytes coincide.
func signPayload(priv ed25519.PrivateKey, domain string, canonical []byte) []byte {
	return ed25519.Sign(priv, signingInput(domain, canonical))
}

func verifyPayload(pub ed25519.PublicKey, domain string, canonical, sig []byte) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(pub, signingInput(domain, canonical), sig)
}

func signingInput(domain string, canonical []byte) []byte {
	in := make([]byte, 0, len(domain)+1+len(canonical))
	in = append(in, domain...)
	in = append(in, '\n')
	in = append(in, canonical...)
	return in
}

// marshalCanonical is json.Marshal with a helpful wrap. Callers pass fixed-field
// structs whose JSON key order is stable, so the output is a deterministic
// canonical encoding usable as both signing input and AEAD AAD.
func marshalCanonical(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, errors.Wrap(err, "marshal canonical")
	}
	return b, nil
}

func jsonUnmarshal(b []byte, v any) error {
	if err := json.Unmarshal(b, v); err != nil {
		return errors.Wrap(err, "unmarshal")
	}
	return nil
}
