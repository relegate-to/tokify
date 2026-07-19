package sharing

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"

	"github.com/go-faster/errors"
)

// Epochs are the revocation/rotation story (plan §2b). An audience keypair is
// minted per membership period; any membership change bumps to a new epoch. The
// load-bearing part is authenticity: authors learn "the current epoch pubkey"
// from the untrusted database, so a malicious server could present its own
// keypair and harvest every author's wrapped DEKs. Every epoch therefore ships
// a signed, hash-chained announcement, and clients must verify it against a
// fingerprint-verified admin key before wrapping anything to the epoch pubkey.

// GenerateEpochKeypair mints a fresh X25519 keypair for an audience epoch.
func GenerateEpochKeypair() (*ecdh.PrivateKey, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.Wrap(err, "generate epoch key")
	}
	return priv, nil
}

// EpochAnnouncement is the signed, chained public record of an epoch (plan §2b,
// §3). PrevHash links to the predecessor's canonical hash so a fork or rollback
// of epoch history is detectable; it is "" for epoch 1.
type EpochAnnouncement struct {
	AudienceID string
	Epoch      int
	EpochPub   []byte
	PrevHash   string
}

// epochCanonical is the fixed-field shape hashed and signed. epoch_pubkey is
// base64, prev_epoch is lowercase hex or "".
type epochCanonical struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
	EpochPub   string `json:"epoch_pubkey"`
	PrevEpoch  string `json:"prev_epoch"`
}

// Canonical returns the deterministic bytes that are hashed for the chain link
// and signed by the admin.
func (e EpochAnnouncement) Canonical() ([]byte, error) {
	return marshalCanonical(epochCanonical{
		AudienceID: e.AudienceID,
		Epoch:      e.Epoch,
		EpochPub:   b64(e.EpochPub),
		PrevEpoch:  e.PrevHash,
	})
}

// Hash returns the lowercase-hex SHA-256 of the announcement's canonical bytes —
// the value the next epoch's PrevHash must equal.
func (e EpochAnnouncement) Hash() (string, error) {
	canonical, err := e.Canonical()
	if err != nil {
		return "", err
	}
	return hexHash(canonical), nil
}

// SignAnnouncement signs an epoch announcement with an admin's Ed25519 key
// (domain "tokify-share-epoch-v1").
func SignAnnouncement(adminSigPriv ed25519.PrivateKey, e EpochAnnouncement) ([]byte, error) {
	canonical, err := e.Canonical()
	if err != nil {
		return nil, err
	}
	return signPayload(adminSigPriv, domainEpoch, canonical), nil
}

// VerifyAnnouncement verifies an epoch announcement's signature against an admin
// signing key. The caller is responsible for having fingerprint-verified that
// key out of band (plan §9) — this only proves the announcement was signed by
// whoever holds it.
func VerifyAnnouncement(adminSigPub ed25519.PublicKey, e EpochAnnouncement, sig []byte) (bool, error) {
	canonical, err := e.Canonical()
	if err != nil {
		return false, err
	}
	return verifyPayload(adminSigPub, domainEpoch, canonical, sig), nil
}

// VerifyChain is the client's fork/rollback detector (plan §2b). It verifies,
// for a full ordered history of one audience's epochs, that:
//
//   - every announcement's signature verifies under its paired admin key;
//   - epochs are contiguous ascending 1..N;
//   - the first PrevHash is "" and each subsequent PrevHash equals its
//     predecessor's Hash();
//
// Any violation is a hard error identifying the offending epoch — never a
// warning. A caller that cannot verify the chain must refuse to wrap to the
// epoch, because an unverifiable epoch is the cheapest full-plaintext exfil.
//
// sigs and adminPubs are parallel to anns; adminPubs[i] is the fingerprint-
// verified admin key expected to have signed anns[i].
func VerifyChain(anns []EpochAnnouncement, sigs [][]byte, adminPubs []ed25519.PublicKey) error {
	if len(anns) == 0 {
		return errors.New("empty epoch chain")
	}
	if len(sigs) != len(anns) || len(adminPubs) != len(anns) {
		return errors.New("chain, sigs, and admin keys must be equal length")
	}

	prevHash := ""
	for i, ann := range anns {
		wantEpoch := i + 1
		if ann.Epoch != wantEpoch {
			return errors.Errorf("epoch %d: non-contiguous or non-monotonic (got epoch=%d at position %d)", ann.Epoch, ann.Epoch, i)
		}
		if ann.PrevHash != prevHash {
			return errors.Errorf("epoch %d: prev_epoch chain break (fork or rollback)", ann.Epoch)
		}

		ok, err := VerifyAnnouncement(adminPubs[i], ann, sigs[i])
		if err != nil {
			return errors.Wrapf(err, "epoch %d: canonicalize", ann.Epoch)
		}
		if !ok {
			return errors.Errorf("epoch %d: bad admin signature", ann.Epoch)
		}

		h, err := ann.Hash()
		if err != nil {
			return errors.Wrapf(err, "epoch %d: hash", ann.Epoch)
		}
		prevHash = h
	}
	return nil
}

// The three wrappers below are thin, named forms of SealTo so call sites read
// as intent rather than as raw seals. Each binds the AAD the plan mandates for
// that wrap (§2a, §2b, §4a).

// WrapEpochKeyToMember seals an epoch private key to a member's identity public
// key, binding (audience_id, epoch, member_id). This is level 3 of the plan's
// hierarchy: audience epoch private key wrapped to each member.
func WrapEpochKeyToMember(memberEncPub, epochPriv []byte, a EpochKeyAAD) ([]byte, error) {
	aad, err := EpochKeyAADBytes(a)
	if err != nil {
		return nil, err
	}
	return SealTo(memberEncPub, epochPriv, aad)
}

// UnwrapEpochKeyForMember reverses WrapEpochKeyToMember using the member's
// identity private key.
func UnwrapEpochKeyForMember(memberEncPriv, wire []byte, a EpochKeyAAD) ([]byte, error) {
	aad, err := EpochKeyAADBytes(a)
	if err != nil {
		return nil, err
	}
	return OpenSealed(memberEncPriv, wire, aad)
}

// WrapDEKToEpoch seals an entry DEK to an audience epoch public key, binding
// (entry_id, audience_id, epoch). This is level 2: the DEK wrapped once per
// (entry x audience), never per member — the indirection that makes teams free.
func WrapDEKToEpoch(epochPub, dek []byte, a GrantAAD) ([]byte, error) {
	aad, err := GrantAADBytes(a)
	if err != nil {
		return nil, err
	}
	return SealTo(epochPub, dek, aad)
}

// UnwrapDEKFromEpoch reverses WrapDEKToEpoch using the epoch private key.
func UnwrapDEKFromEpoch(epochPriv, wire []byte, a GrantAAD) ([]byte, error) {
	aad, err := GrantAADBytes(a)
	if err != nil {
		return nil, err
	}
	return OpenSealed(epochPriv, wire, aad)
}

// WrapFilterToEpoch encrypts a share filter to the audience's current epoch
// public key, binding (audience_id, epoch). The DB never evaluates this; it is
// re-wrapped on every epoch bump (plan §4a).
func WrapFilterToEpoch(epochPub, filterJSON []byte, a FilterAAD) ([]byte, error) {
	aad, err := FilterAADBytes(a)
	if err != nil {
		return nil, err
	}
	return SealTo(epochPub, filterJSON, aad)
}

// UnwrapFilterFromEpoch reverses WrapFilterToEpoch using the epoch private key.
func UnwrapFilterFromEpoch(epochPriv, wire []byte, a FilterAAD) ([]byte, error) {
	aad, err := FilterAADBytes(a)
	if err != nil {
		return nil, err
	}
	return OpenSealed(epochPriv, wire, aad)
}

// WrapNameToEpoch seals a team name to the audience epoch public key, binding
// (audience_id, epoch, kind=team_name). Like the share filter it is metadata the
// server must never read, so it is sealed to the epoch key any member can unwrap.
func WrapNameToEpoch(epochPub, name []byte, a NameAAD) ([]byte, error) {
	aad, err := NameAADBytes(a)
	if err != nil {
		return nil, err
	}
	return SealTo(epochPub, name, aad)
}

// UnwrapNameFromEpoch reverses WrapNameToEpoch using the epoch private key.
func UnwrapNameFromEpoch(epochPriv, wire []byte, a NameAAD) ([]byte, error) {
	aad, err := NameAADBytes(a)
	if err != nil {
		return nil, err
	}
	return OpenSealed(epochPriv, wire, aad)
}
