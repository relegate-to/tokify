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
	// Sharing identity (sharing_schema.sql adds these columns). Empty until an
	// account is provisioned for sharing; populated by patchIdentityColumns.
	WrappedIdentity string `json:"wrapped_identity,omitempty"`
	IdentityNonce   string `json:"identity_nonce,omitempty"`
}

type entryRow struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
	// omitempty matters on writes: push upserts live entries and must never send
	// deleted=false, or a merge-duplicates upsert would clobber a tombstone set
	// by another device. Omitting the column leaves the existing value (or the
	// DEFAULT false on insert) untouched. Reads still populate it normally.
	Deleted bool `json:"deleted,omitempty"`
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

// markDeleted flips the `deleted` tombstone flag to true on the caller's entry
// rows whose id is in ids. The ciphertext row is intentionally kept (not hard
// deleted) so other devices learn of the removal on their next pull instead of
// resurrecting the entry from their still-live local copy. RLS scopes the PATCH
// to the JWT owner. ids are hex content hashes, so they need no URL escaping.
func markDeleted(ctx context.Context, hc *http.Client, base, token string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	path := "/entries?id=in.(" + strings.Join(ids, ",") + ")"
	body := []byte(`{"deleted":true}`)
	_, err := doJSON(ctx, hc, http.MethodPatch, endpoint(base, path), token, body, "return=minimal")
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

// apiStatusError carries PostgREST's structured error alongside the HTTP status
// so callers can branch on it (e.g. a unique-violation on an idempotent insert)
// while its Error() text stays the human-readable message for the UI.
type apiStatusError struct {
	status  int
	code    string
	message string
	hint    string
}

func (e *apiStatusError) Error() string {
	if e.message == "" {
		return fmt.Sprintf("neonsync: request failed (%d)", e.status)
	}
	if e.hint != "" {
		return fmt.Sprintf("%s (%s)", e.message, e.hint)
	}
	return e.message
}

// apiError extracts PostgREST's `{ "message", "hint", "details", "code" }` error
// body so the UI can show the real reason rather than a bare status.
func apiError(status int, body []byte) error {
	e := &apiStatusError{status: status}
	var parsed struct {
		Message string `json:"message"`
		Hint    string `json:"hint"`
		Code    string `json:"code"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		e.message, e.hint, e.code = parsed.Message, parsed.Hint, parsed.Code
	}
	return e
}

// isUniqueViolation reports whether err is a PostgREST duplicate-key error
// (Postgres 23505, surfaced as HTTP 409) — the signal that an idempotent insert
// hit an already-present row and can be treated as success.
func isUniqueViolation(err error) bool {
	var e *apiStatusError
	return errors.As(err, &e) && (e.code == "23505" || e.status == http.StatusConflict)
}
