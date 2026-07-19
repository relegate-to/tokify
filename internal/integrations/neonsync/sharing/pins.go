package sharing

import (
	"github.com/go-faster/errors"
	"golang.org/x/crypto/chacha20poly1305"
)

// pinsAAD binds a wrapped pin store to its owner and to the "pins" domain. The
// domain field keeps a wrapped pin blob and a wrapped identity blob from ever
// authenticating in each other's slot even if they were sealed under the same
// key — defence in depth on top of the two being sealed under different keys
// (identity under the password-KEK, pins under the account DEK).
type pinsAAD struct {
	UserID string `json:"user_id"`
	Kind   string `json:"kind"`
}

func pinsWrapAAD(userID string) ([]byte, error) {
	return marshalCanonical(pinsAAD{UserID: userID, Kind: "pins"})
}

// WrapPins seals an opaque pin-store blob under the 32-byte account DEK with the
// owner bound as AAD, returning the ciphertext and its detached random nonce
// (the same two-column seal pattern as WrapIdentity). The DEK is used rather
// than the password-KEK because the pin store is re-pushed mid-session whenever
// a new pin is recorded, and only the DEK stays cached after Unlock.
func WrapPins(blob, dek []byte, userID string) ([]byte, []byte, error) {
	if len(dek) != keyLen {
		return nil, nil, errors.Errorf("dek length = %d, want %d", len(dek), keyLen)
	}
	aad, err := pinsWrapAAD(userID)
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
	return aead.Seal(nil, nonce, blob, aad), nonce, nil
}

// UnwrapPins recovers a pin-store blob sealed by WrapPins. A wrong DEK or a
// mismatched userID both fail as an authentication error rather than returning
// garbage bytes.
func UnwrapPins(ciphertext, nonce, dek []byte, userID string) ([]byte, error) {
	if len(dek) != keyLen {
		return nil, errors.Errorf("dek length = %d, want %d", len(dek), keyLen)
	}
	if len(nonce) != nonceLen {
		return nil, errors.New("wrong nonce size")
	}
	aad, err := pinsWrapAAD(userID)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(dek)
	if err != nil {
		return nil, errors.Wrap(err, "new aead")
	}
	blob, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.Wrap(err, "unwrap pins")
	}
	return blob, nil
}
