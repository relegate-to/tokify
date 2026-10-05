package neonsync

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"time"

	"github.com/go-faster/errors"
)

// ColorPref is one project's pinned display color and when it was chosen. An
// empty Color is a deliberate reset to the name-derived default, kept (with its
// time) so the reset itself syncs instead of being undone by an older pin.
type ColorPref struct {
	Color string `json:"color"`
	At    string `json:"at"`
}

// projectPrefs is the account's project presentation, sealed under the DEK in
// user_keys.wrapped_projects so every device colors projects the same way. The
// server sees one opaque blob per user.
type projectPrefs struct {
	Colors map[string]ColorPref `json:"colors"`
}

type projectPrefsAAD struct {
	UserID string `json:"user_id"`
	Kind   string `json:"kind"`
}

// SyncProjectColors merges this device's colors with the account's synced ones
// and returns the result, writing it back when the server's copy was behind.
// Per project the most recent choice wins. A server without the
// wrapped_projects column yet returns the local colors unchanged.
func (s *Service) SyncProjectColors(ctx context.Context, local map[string]ColorPref) (map[string]ColorPref, error) {
	base, token, dek, err := s.timerAccess(ctx)
	if err != nil {
		return nil, err
	}
	row, err := getUserKeys(ctx, s.http, base, token)
	if err != nil {
		return nil, err
	}
	aad, err := json.Marshal(projectPrefsAAD{UserID: row.UserID, Kind: "projects"})
	if err != nil {
		return nil, errors.Wrap(err, "marshal projects aad")
	}
	remote := map[string]ColorPref{}
	if row.WrappedProjects != "" && row.ProjectsNonce != "" {
		ct, cerr := unb64(row.WrappedProjects)
		nonce, nerr := unb64(row.ProjectsNonce)
		if cerr == nil && nerr == nil {
			if plain, oerr := openAAD(dek, ct, nonce, aad); oerr == nil {
				var p projectPrefs
				if json.Unmarshal(plain, &p) == nil && p.Colors != nil {
					remote = p.Colors
				}
			}
		}
	}
	merged := MergeColors(remote, local)
	if maps.Equal(merged, remote) {
		return merged, nil
	}
	plain, err := json.Marshal(projectPrefs{Colors: merged})
	if err != nil {
		return nil, errors.Wrap(err, "marshal project colors")
	}
	ct, nonce, err := sealAAD(dek, plain, aad)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]string{"wrapped_projects": b64(ct), "projects_nonce": b64(nonce)})
	if err != nil {
		return nil, errors.Wrap(err, "marshal project colors patch")
	}
	if _, perr := doJSON(ctx, s.http, http.MethodPatch, endpoint(base, "/user_keys"), token, body, "return=minimal"); perr != nil {
		if isUnknownColumn(perr) {
			return local, nil
		}
		return nil, errors.Wrap(perr, "push project colors")
	}
	return merged, nil
}

// MergeColors folds two color sets together, keeping each project's most
// recent choice; on a tie the first set's wins.
func MergeColors(a, b map[string]ColorPref) map[string]ColorPref {
	out := maps.Clone(a)
	if out == nil {
		out = map[string]ColorPref{}
	}
	for name, pref := range b {
		cur, ok := out[name]
		if !ok || colorTime(pref.At).After(colorTime(cur.At)) {
			out[name] = pref
		}
	}
	return out
}

func colorTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
