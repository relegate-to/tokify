package neonsync

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"strings"

	"github.com/go-faster/errors"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

// This file is the whole cryptographic core of the sync feature and is pure and
// unit-tested. The design (see docs/ plan) is zero-knowledge: the login
// password never leaves the device, and the server only ever holds ciphertext.
//
// Two independent Argon2id branches, domain-separated so the value sent for
// auth cannot be reversed into the encryption key:
//
//	H_auth = Argon2id(password, salt = HKDF(email, "auth"))  -> sent to Neon Auth
//	KEK    = Argon2id(password, salt_enc)                    -> never sent anywhere
//	DEK    = unwrap(wrapped_dek, KEK)                         -> random data key
//
// Entries are encrypted with the DEK. The KEK only ever wraps the DEK, so a
// password change re-wraps one small blob and email changes never touch the
// encryption path (salt_enc is a server-stored random value, not the email).

const (
	// keyLen is the byte length of every derived/random key here: the KEK, the
	// DEK, and the HKDF-derived auth salt all fit XChaCha20-Poly1305's 32-byte
	// key requirement.
	keyLen = 32

	// saltEncLen is the length of the random per-user salt anchoring the KEK.
	saltEncLen = 16

	// Argon2id cost. Deliberately high: the server's only path to the DEK is an
	// offline crack of the password, so this cost is the user's margin. 64 MiB /
	// 3 passes / 4 lanes is a common interactive-but-hardened setting.
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 4
)

// authInfo domain-separates the auth-salt HKDF from everything else. Versioned
// so a future scheme can coexist.
const authInfo = "toki-sync-auth-salt-v1"

// DeriveAuthHash produces the value the client sends to Neon Auth as the
// "password". It is Argon2id over the real password with a salt deterministically
// derived from the (normalized) email, so the same credentials always yield the
// same hash without the server ever seeing the real password. Returned as
// standard base64 so it survives JSON transport unchanged.
func DeriveAuthHash(email, password string) (string, error) {
	if password == "" {
		return "", errors.New("password is empty")
	}
	salt := hkdfSalt(normalizeEmail(email))
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, keyLen)
	return base64.StdEncoding.EncodeToString(key), nil
}

// hkdfSalt derives a fixed-length salt from the email via HKDF-SHA256 under the
// auth domain-separation info. Email is the input keying material; there is no
// separate secret, which is fine because this only salts a slow hash, it is not
// itself a secret.
func hkdfSalt(email string) []byte {
	r := hkdf.New(sha256.New, []byte(email), nil, []byte(authInfo))
	salt := make([]byte, saltEncLen)
	// HKDF's reader cannot short-read for this small a length; treat any error as
	// fatal misuse rather than propagating it up every call site.
	if _, err := io.ReadFull(r, salt); err != nil {
		panic("neonsync: hkdf salt: " + err.Error())
	}
	return salt
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// DeriveKEK derives the key-encryption key from the password and the server-
// stored random salt_enc. This branch never touches the email, so an email
// change cannot break decryption.
func DeriveKEK(password string, saltEnc []byte) []byte {
	return argon2.IDKey([]byte(password), saltEnc, argonTime, argonMemory, argonThreads, keyLen)
}

// GenerateSalt returns a fresh random salt_enc for a new user_keys row.
func GenerateSalt() ([]byte, error) {
	return randomBytes(saltEncLen)
}

// GenerateDEK returns a fresh random data-encryption key.
func GenerateDEK() ([]byte, error) {
	return randomBytes(keyLen)
}

// WrapDEK seals the DEK under the KEK, returning the wrapped bytes and the nonce.
func WrapDEK(dek, kek []byte) ([]byte, []byte, error) {
	return seal(kek, dek)
}

// UnwrapDEK recovers the DEK from its wrapped form using the KEK. A wrong
// password (wrong KEK) surfaces as an authentication failure here, which is how
// the caller learns the password was wrong without the server being involved.
func UnwrapDEK(wrapped, nonce, kek []byte) ([]byte, error) {
	return open(kek, wrapped, nonce)
}

// EncryptEntry seals one serialized entry under the DEK.
func EncryptEntry(dek, plaintext []byte) ([]byte, []byte, error) {
	return seal(dek, plaintext)
}

// DecryptEntry recovers one serialized entry from its ciphertext + nonce.
func DecryptEntry(dek, ciphertext, nonce []byte) ([]byte, error) {
	return open(dek, ciphertext, nonce)
}

// EntryID is the deterministic, keyed content id for an entry: hex
// HMAC-SHA256(DEK, canonical). Keyed by the DEK so the server sees stable ids
// that let upserts dedupe, without being able to tell two users apart by equal
// plaintext (a plain hash would leak that). Hex so it is a safe PostgREST PK.
func EntryID(dek, canonical []byte) string {
	mac := hmac.New(sha256.New, dek)
	mac.Write(canonical)
	return hex.EncodeToString(mac.Sum(nil))
}

// seal performs XChaCha20-Poly1305 with a fresh random 24-byte nonce, returning
// the detached nonce alongside the ciphertext so callers can store them in
// separate columns.
func seal(key, plaintext []byte) ([]byte, []byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, nil, errors.Wrap(err, "new aead")
	}
	nonce, err := randomBytes(aead.NonceSize())
	if err != nil {
		return nil, nil, err
	}
	return aead.Seal(nil, nonce, plaintext, nil), nonce, nil
}

func open(key, ciphertext, nonce []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, errors.Wrap(err, "new aead")
	}
	if len(nonce) != aead.NonceSize() {
		return nil, errors.New("wrong nonce size")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		// Covers a wrong key, a tampered ciphertext, and nonce reuse detection —
		// all indistinguishable and all a hard failure.
		return nil, errors.Wrap(err, "decrypt")
	}
	return plaintext, nil
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, errors.Wrap(err, "read random")
	}
	return b, nil
}
