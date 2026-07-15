package sharing

import (
	"crypto/ed25519"
	"crypto/sha256"
	"io"

	"github.com/go-faster/errors"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

// The structs below are the frozen canonical shapes for AAD and signing
// payloads (plan §2a). Field names and their JSON key order are part of the
// wire contract; the exported helpers exist so the operations layer produces
// these bytes through one code path and cannot get field order wrong.

// EntryAAD binds an entry ciphertext to its identity so a spliced payload fails
// to decrypt (plan §2a: entries bind (entry_id, version, author_id)).
type EntryAAD struct {
	EntryID  string `json:"entry_id"`
	Version  int    `json:"version"`
	AuthorID string `json:"author_id"`
}

// GrantAAD binds a wrapped DEK to the (entry, audience, epoch) it grants, so a
// server cannot swap grants between entries or replay them onto another epoch.
type GrantAAD struct {
	EntryID    string `json:"entry_id"`
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
}

// EpochKeyAAD binds a wrapped epoch private key to its (audience, epoch, member)
// so a member's wrapped key cannot be re-presented as another member's.
type EpochKeyAAD struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
	MemberID   string `json:"member_id"`
}

// FilterAAD binds an encrypted share filter to its audience and epoch (plan
// §4a: the filter is re-wrapped to the current epoch key on every bump).
type FilterAAD struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
}

// NameAAD binds an encrypted team name to its audience and epoch. It carries the
// same (audience, epoch) tuple as FilterAAD, so NameAADBytes stamps a constant
// kind to keep the two AADs distinct: without it a server could present a share
// filter's ciphertext in the team-name slot (or vice versa) and it would decrypt.
type NameAAD struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
}

// nameAADCanonical is the wire shape NameAADBytes marshals — the kind field is
// fixed here (not caller-supplied) so it can never be omitted or varied.
type nameAADCanonical struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
	Kind       string `json:"kind"`
}

// entrySigPayload is the canonical body an author signs for an entry: the AAD
// tuple plus the base64 ciphertext (plan §3: Ed25519 over id, version, payload
// ciphertext).
type entrySigPayload struct {
	EntryID    string `json:"entry_id"`
	Version    int    `json:"version"`
	AuthorID   string `json:"author_id"`
	Ciphertext string `json:"ciphertext"`
}

// grantSigPayload is the canonical body an author signs for a grant: the grant
// tuple plus the base64 SealTo wire of the wrapped DEK.
type grantSigPayload struct {
	EntryID    string `json:"entry_id"`
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
	WrappedDEK string `json:"wrapped_dek"`
}

// EntryAADBytes returns the canonical AAD for an entry payload.
func EntryAADBytes(a EntryAAD) ([]byte, error) { return marshalCanonical(a) }

// GrantAADBytes returns the canonical AAD for a wrapped DEK in a grant.
func GrantAADBytes(a GrantAAD) ([]byte, error) { return marshalCanonical(a) }

// EpochKeyAADBytes returns the canonical AAD for a wrapped epoch private key.
func EpochKeyAADBytes(a EpochKeyAAD) ([]byte, error) { return marshalCanonical(a) }

// FilterAADBytes returns the canonical AAD for an encrypted share filter.
func FilterAADBytes(a FilterAAD) ([]byte, error) { return marshalCanonical(a) }

// NameAADBytes returns the canonical AAD for an encrypted team name, with the
// fixed kind="team_name" giving it domain separation from FilterAADBytes.
func NameAADBytes(a NameAAD) ([]byte, error) {
	return marshalCanonical(nameAADCanonical{AudienceID: a.AudienceID, Epoch: a.Epoch, Kind: "team_name"})
}

// EntrySigBytes returns the canonical bytes an author signs over an entry, given
// the raw ciphertext (base64-encoded internally so the signed value is text).
func EntrySigBytes(a EntryAAD, ciphertext []byte) ([]byte, error) {
	return marshalCanonical(entrySigPayload{
		EntryID:    a.EntryID,
		Version:    a.Version,
		AuthorID:   a.AuthorID,
		Ciphertext: b64(ciphertext),
	})
}

// GrantSigBytes returns the canonical bytes an author signs over a grant, given
// the wrapped-DEK SealTo wire.
func GrantSigBytes(a GrantAAD, wrappedDEK []byte) ([]byte, error) {
	return marshalCanonical(grantSigPayload{
		EntryID:    a.EntryID,
		AudienceID: a.AudienceID,
		Epoch:      a.Epoch,
		WrappedDEK: b64(wrappedDEK),
	})
}

// SignEntry produces the author's Ed25519 signature over an entry (domain
// "tokify-share-entry-v1").
func SignEntry(sigPriv ed25519.PrivateKey, a EntryAAD, ciphertext []byte) ([]byte, error) {
	canonical, err := EntrySigBytes(a, ciphertext)
	if err != nil {
		return nil, err
	}
	return signPayload(sigPriv, domainEntry, canonical), nil
}

// VerifyEntrySig verifies an author's entry signature against their signing key.
func VerifyEntrySig(sigPub ed25519.PublicKey, a EntryAAD, ciphertext, sig []byte) (bool, error) {
	canonical, err := EntrySigBytes(a, ciphertext)
	if err != nil {
		return false, err
	}
	return verifyPayload(sigPub, domainEntry, canonical, sig), nil
}

// SignGrant produces the author's Ed25519 signature over a grant (domain
// "tokify-share-grant-v1").
func SignGrant(sigPriv ed25519.PrivateKey, a GrantAAD, wrappedDEK []byte) ([]byte, error) {
	canonical, err := GrantSigBytes(a, wrappedDEK)
	if err != nil {
		return nil, err
	}
	return signPayload(sigPriv, domainGrant, canonical), nil
}

// VerifyGrantSig verifies an author's grant signature against their signing key.
func VerifyGrantSig(sigPub ed25519.PublicKey, a GrantAAD, wrappedDEK, sig []byte) (bool, error) {
	canonical, err := GrantSigBytes(a, wrappedDEK)
	if err != nil {
		return false, err
	}
	return verifyPayload(sigPub, domainGrant, canonical, sig), nil
}

// DeriveEntryDEK deterministically derives an entry's DEK from the account DEK
// and the entry id (plan §3 deviation, documented in the package doc). Because
// entry ids are keyed content hashes the plaintext for an id is immutable, so a
// derived DEK is as safe as a stored one and needs no wrapped_dek_author
// column: the author simply re-derives. HKDF-SHA256 with an info that binds the
// entry id means two ids never share a DEK.
func DeriveEntryDEK(accountDEK []byte, entryID string) ([]byte, error) {
	info := append([]byte(domainEntryDEK+":"), entryID...)
	r := hkdf.New(sha256.New, accountDEK, nil, info)
	dek := make([]byte, keyLen)
	if _, err := io.ReadFull(r, dek); err != nil {
		return nil, errors.Wrap(err, "derive entry dek")
	}
	return dek, nil
}

// EncryptEntryPayload seals an entry's plaintext under its DEK, binding the
// EntryAAD as AAD, and returns the ciphertext with a detached random nonce.
func EncryptEntryPayload(dek, plaintext []byte, a EntryAAD) ([]byte, []byte, error) {
	aad, err := EntryAADBytes(a)
	if err != nil {
		return nil, nil, err
	}
	aead, err := chacha20poly1305.NewX(dek)
	if err != nil {
		return nil, nil, errors.Wrap(err, "new aead")
	}
	nonce, err := randomBytes(nonceLen)
	if err != nil {
		return nil, nil, err
	}
	return aead.Seal(nil, nonce, plaintext, aad), nonce, nil
}

// DecryptEntryPayload recovers an entry's plaintext. A wrong version or author
// in the AAD (a server replaying an old version or mis-attributing authorship)
// fails as an authentication error, not a silent wrong answer (plan §2a, §8).
func DecryptEntryPayload(dek, ciphertext, nonce []byte, a EntryAAD) ([]byte, error) {
	if len(nonce) != nonceLen {
		return nil, errors.New("wrong nonce size")
	}
	aad, err := EntryAADBytes(a)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(dek)
	if err != nil {
		return nil, errors.Wrap(err, "new aead")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.Wrap(err, "decrypt entry payload")
	}
	return plaintext, nil
}
