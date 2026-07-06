package neonsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	gerrors "github.com/go-faster/errors"
)

// ErrNoUserKeys signals that the caller has never provisioned a user_keys row.
// It's the cue to create one on first sign-up rather than an error to surface.
var ErrNoUserKeys = errors.New("neonsync: no encrypted-sync key provisioned")

// The wire rows mirror the schema.sql columns exactly. Every key/ciphertext
// field is base64 text so it round-trips through JSON untouched; the server
// stores it opaquely. updated_at is server-set (trigger) and read-only here.
type userKeysRow struct {
	UserID     string `json:"user_id"`
	SaltEnc    string `json:"salt_enc"`
	WrappedDEK string `json:"wrapped_dek"`
	WrapNonce  string `json:"wrap_nonce"`
}

type entryRow struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
	Deleted    bool   `json:"deleted"`
}

func endpoint(base, path string) string {
	return strings.TrimRight(base, "/") + path
}

// hostOf returns the bare hostname of a URL, for the offline reachability probe.
func hostOf(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// getUserKeys fetches the caller's user_keys row. RLS scopes the result to the
// JWT owner, so no filter is needed. Returns ErrNoUserKeys when the user has
// never provisioned a key — the signal to create one on first sign-up.
func getUserKeys(ctx context.Context, hc *http.Client, base, token string) (*userKeysRow, error) {
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, "/user_keys?select=*"), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []userKeysRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode user_keys")
	}
	if len(rows) == 0 {
		return nil, ErrNoUserKeys
	}
	return &rows[0], nil
}

// insertUserKeys creates the caller's user_keys row. WITH CHECK on the table
// rejects any attempt to stamp a foreign user_id, so this can only ever write
// the caller's own row.
func insertUserKeys(ctx context.Context, hc *http.Client, base, token string, row userKeysRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/user_keys"), token, body, "return=minimal")
	return err
}

// getEntries fetches every entry row the caller owns (RLS-scoped).
func getEntries(ctx context.Context, hc *http.Client, base, token string) ([]entryRow, error) {
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, "/entries?select=*"), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []entryRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode entries")
	}
	return rows, nil
}

// upsertEntries writes entry rows idempotently. resolution=merge-duplicates
// makes PostgREST upsert on the primary key (id = keyed content hash), so
// re-pushing an unchanged entry is a no-op and pushing from two devices dedupes.
func upsertEntries(ctx context.Context, hc *http.Client, base, token string, rows []entryRow) error {
	if len(rows) == 0 {
		return nil
	}
	body, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/entries"), token,
		body, "resolution=merge-duplicates,return=minimal")
	return err
}

// doJSON performs one Data API request with the bearer JWT and returns the
// response body. prefer, when non-empty, sets the PostgREST Prefer header.
func doJSON(ctx context.Context, hc *http.Client, method, url, token string, body []byte, prefer string) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if prefer != "" {
		req.Header.Set("Prefer", prefer)
	}

	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, apiError(resp.StatusCode, data)
	}
	return data, nil
}

// apiError extracts PostgREST's `{ "message", "hint", "details", "code" }` error
// body so the UI can show the real reason rather than a bare status.
func apiError(status int, body []byte) error {
	var e struct {
		Message string `json:"message"`
		Hint    string `json:"hint"`
		Code    string `json:"code"`
	}
	if json.Unmarshal(body, &e) == nil && e.Message != "" {
		if e.Hint != "" {
			return fmt.Errorf("%s (%s)", e.Message, e.Hint)
		}
		return errorString(e.Message)
	}
	return fmt.Errorf("neonsync: request failed (%d)", status)
}

// errorString is a tiny helper so apiError can return a plain message without a
// format directive misreading a `%` in the server text.
func errorString(s string) error { return gerrors.New(s) }
