package neonsync

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	gerrors "github.com/go-faster/errors"
)

// ErrSketchpadConflict means another device wrote the sketchpad since the
// caller read it. The returned state is the fresh one to merge with.
var ErrSketchpadConflict = errors.New("neonsync: sketchpad changed on another device")

// SketchpadState is one read of the account's sketchpad. Version 0 means no
// device has written one; Owner is the account the record belongs to.
type SketchpadState struct {
	Version int64
	Owner   string
	HTML    string
}

type sketchpadPlain struct {
	HTML string `json:"h"`
}

// Sketchpad reads and decrypts the caller's sketchpad. A server without the
// sketchpads table yet reads as a pad nobody has written.
func (s *Service) Sketchpad(ctx context.Context) (SketchpadState, error) {
	base, token, dek, err := s.timerAccess(ctx)
	if err != nil {
		return SketchpadState{}, err
	}
	state, err := readSketchpad(ctx, s.http, base, token, dek)
	if isMissingSchema(err) {
		return SketchpadState{}, nil
	}
	return state, err
}

// PutSketchpad replaces the sketchpad, provided it is still at version seen.
// On ErrSketchpadConflict the returned state is the fresh one.
func (s *Service) PutSketchpad(ctx context.Context, seen int64, html string) (SketchpadState, error) {
	base, token, dek, err := s.timerAccess(ctx)
	if err != nil {
		return SketchpadState{}, err
	}
	owner, err := ownerFromKeys(ctx, s.http, base, token)
	if err != nil {
		return SketchpadState{}, err
	}
	return writeSketchpad(ctx, s.http, base, token, dek, owner, seen, html)
}

func readSketchpad(ctx context.Context, hc *http.Client, base, token string, dek []byte) (SketchpadState, error) {
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, "/sketchpads?select=*"), token, nil, "")
	if err != nil {
		return SketchpadState{}, gerrors.Wrap(err, "read sketchpad")
	}
	var rows []versionedRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return SketchpadState{}, gerrors.Wrap(uerr, "decode sketchpad")
	}
	if len(rows) == 0 {
		return SketchpadState{}, nil
	}
	return openSketchpad(dek, rows[0])
}

func writeSketchpad(
	ctx context.Context,
	hc *http.Client,
	base, token string,
	dek []byte,
	owner string,
	seen int64,
	html string,
) (SketchpadState, error) {
	row, err := sealSketchpad(dek, owner, seen+1, html)
	if err != nil {
		return SketchpadState{}, err
	}
	body, err := json.Marshal(row)
	if err != nil {
		return SketchpadState{}, err
	}
	won, err := putVersioned(ctx, hc, base, token, "sketchpads", seen, body)
	if err != nil {
		return SketchpadState{}, err
	}
	if !won {
		fresh, rerr := readSketchpad(ctx, hc, base, token, dek)
		if rerr != nil {
			return SketchpadState{}, rerr
		}
		return fresh, ErrSketchpadConflict
	}
	return SketchpadState{Version: row.Version, Owner: owner, HTML: html}, nil
}

// sketchpadAAD binds a ciphertext to its owner and version, so the server
// cannot present an older pad under a newer version number.
func sketchpadAAD(owner string, version int64) []byte {
	return []byte("tokify/sketchpad/v1\x00" + owner + "\x00" + strconv.FormatInt(version, 10))
}

func sealSketchpad(dek []byte, owner string, version int64, html string) (versionedRow, error) {
	plain, err := json.Marshal(sketchpadPlain{HTML: html})
	if err != nil {
		return versionedRow{}, err
	}
	ct, nonce, err := sealAAD(dek, plain, sketchpadAAD(owner, version))
	if err != nil {
		return versionedRow{}, err
	}
	return versionedRow{UserID: owner, Version: version, Ciphertext: b64(ct), Nonce: b64(nonce)}, nil
}

func openSketchpad(dek []byte, row versionedRow) (SketchpadState, error) {
	ct, err := unb64(row.Ciphertext)
	if err != nil {
		return SketchpadState{}, err
	}
	nonce, err := unb64(row.Nonce)
	if err != nil {
		return SketchpadState{}, err
	}
	plain, err := openAAD(dek, ct, nonce, sketchpadAAD(row.UserID, row.Version))
	if err != nil {
		return SketchpadState{}, gerrors.Wrap(err, "sketchpad")
	}
	var p sketchpadPlain
	if uerr := json.Unmarshal(plain, &p); uerr != nil {
		return SketchpadState{}, gerrors.Wrap(uerr, "decode sketchpad")
	}
	return SketchpadState{Version: row.Version, Owner: row.UserID, HTML: p.HTML}, nil
}
