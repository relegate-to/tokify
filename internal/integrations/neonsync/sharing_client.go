package neonsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	gerrors "github.com/go-faster/errors"
)

// This file is the PostgREST transport for the sharing tables (sharing_schema.sql).
// Row structs mirror the columns exactly; every key/ciphertext/signature field is
// base64 (or hex, for prev_epoch) text so it round-trips through JSON untouched.
// All calls reuse the doJSON helper and the bearer JWT; RLS scopes what each verb
// may read or write, so these functions never filter by the caller's own id.

// identityRow is a public identity (identities table): only the public halves,
// readable by any authenticated caller so admins can wrap epoch keys to members.
type identityRow struct {
	UserID    string `json:"user_id"`
	PubEnc    string `json:"pub_enc"`
	PubSig    string `json:"pub_sig"`
	EmailHash string `json:"email_hash,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// audienceRow mirrors audiences. current_epoch is server-maintained (bump-pointer
// trigger); it is read-only here and omitted on insert so the DEFAULT 0 applies.
type audienceRow struct {
	ID           string `json:"id"`
	CreatedBy    string `json:"created_by"`
	CurrentEpoch int    `json:"current_epoch,omitempty"`
}

// audienceEpochRow is a signed epoch announcement (§2b).
type audienceEpochRow struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
	EpochPub   string `json:"epoch_pubkey"`
	PrevEpoch  string `json:"prev_epoch"`
	AdminID    string `json:"admin_id"`
	AdminSig   string `json:"admin_sig"`
}

type audienceMemberRow struct {
	AudienceID string `json:"audience_id"`
	MemberID   string `json:"member_id"`
	Role       string `json:"role"`
}

type audienceEpochKeyRow struct {
	AudienceID          string `json:"audience_id"`
	Epoch               int    `json:"epoch"`
	MemberID            string `json:"member_id"`
	WrappedEpochPrivkey string `json:"wrapped_epoch_privkey"`
}

// grantRow mirrors entry_audience_grants. valid_until is a pointer so a NULL
// (no upper bound) is sent as JSON null, not the zero time. revoked/revoked_by
// are read on pull and set only via the dedicated revoke PATCH.
type grantRow struct {
	EntryID    string  `json:"entry_id"`
	AudienceID string  `json:"audience_id"`
	Epoch      int     `json:"epoch"`
	AuthorID   string  `json:"author_id"`
	WrappedDEK string  `json:"wrapped_dek"`
	AuthorSig  string  `json:"author_sig"`
	ValidFrom  string  `json:"valid_from,omitempty"`
	ValidUntil *string `json:"valid_until,omitempty"`
	Revoked    bool    `json:"revoked,omitempty"`
	RevokedBy  *string `json:"revoked_by,omitempty"`
}

type shareRow struct {
	ID               string `json:"id"`
	AudienceID       string `json:"audience_id"`
	Epoch            int    `json:"epoch"`
	FilterCiphertext string `json:"filter_ciphertext"`
	CreatedBy        string `json:"created_by"`
}

// --- identities ---

func getIdentity(ctx context.Context, hc *http.Client, base, token, userID string) (*identityRow, error) {
	path := "/identities?select=*&user_id=eq." + q(userID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []identityRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode identity")
	}
	if len(rows) == 0 {
		return nil, errIdentityNotFound
	}
	return &rows[0], nil
}

// errIdentityNotFound signals that a user has not published an identity row yet.
// The read path treats it as an unpinnable identity (a hard failure to trust).
var errIdentityNotFound = gerrors.New("neonsync: no published identity")

// getIdentitiesByEmailHash finds published identities whose email_hash matches —
// the invite discovery lookup. Returns all matches (normally zero or one); the
// caller resolves ambiguity.
func getIdentitiesByEmailHash(ctx context.Context, hc *http.Client, base, token, emailHash string) ([]identityRow, error) {
	path := "/identities?select=*&email_hash=eq." + q(emailHash)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []identityRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode identities by email")
	}
	return rows, nil
}

// upsertIdentity writes the caller's own public identity row (RLS: own row only).
func upsertIdentity(ctx context.Context, hc *http.Client, base, token string, row identityRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/identities"), token,
		body, "resolution=merge-duplicates,return=minimal")
	return err
}

// patchIdentityColumns writes the wrapped_identity + identity_nonce columns onto
// the caller's user_keys row (RLS-scoped to the JWT owner).
func patchIdentityColumns(ctx context.Context, hc *http.Client, base, token, wrappedIdentity, identityNonce string) error {
	body, err := json.Marshal(map[string]string{
		"wrapped_identity": wrappedIdentity,
		"identity_nonce":   identityNonce,
	})
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPatch, endpoint(base, "/user_keys"), token, body, "return=minimal")
	return err
}

// --- audiences ---

func insertAudience(ctx context.Context, hc *http.Client, base, token string, row audienceRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audiences"), token, body, "return=minimal")
	return err
}

func getAudiences(ctx context.Context, hc *http.Client, base, token string) ([]audienceRow, error) {
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, "/audiences?select=*"), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []audienceRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode audiences")
	}
	return rows, nil
}

// --- audience_epochs ---

func insertEpoch(ctx context.Context, hc *http.Client, base, token string, row audienceEpochRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_epochs"), token, body, "return=minimal")
	return err
}

// getEpochs fetches the FULL ordered epoch history for one audience (1..N),
// which VerifyChain requires — a suffix is not verifiable on its own (§2b).
func getEpochs(ctx context.Context, hc *http.Client, base, token, audienceID string) ([]audienceEpochRow, error) {
	path := "/audience_epochs?select=*&audience_id=eq." + q(audienceID) + "&order=epoch.asc"
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []audienceEpochRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode epochs")
	}
	return rows, nil
}

// --- audience_members ---

func insertMember(ctx context.Context, hc *http.Client, base, token string, row audienceMemberRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_members"), token, body, "return=minimal")
	return err
}

func getMembers(ctx context.Context, hc *http.Client, base, token, audienceID string) ([]audienceMemberRow, error) {
	path := "/audience_members?select=*&audience_id=eq." + q(audienceID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []audienceMemberRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode members")
	}
	return rows, nil
}

func deleteMember(ctx context.Context, hc *http.Client, base, token, audienceID, memberID string) error {
	path := "/audience_members?audience_id=eq." + q(audienceID) + "&member_id=eq." + q(memberID)
	_, err := doJSON(ctx, hc, http.MethodDelete, endpoint(base, path), token, nil, "return=minimal")
	return err
}

// --- audience_epoch_keys ---

func insertEpochKeys(ctx context.Context, hc *http.Client, base, token string, rows []audienceEpochKeyRow) error {
	if len(rows) == 0 {
		return nil
	}
	body, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_epoch_keys"), token,
		body, "resolution=merge-duplicates,return=minimal")
	return err
}

// getMyEpochKeys fetches the epoch keys wrapped to the caller for one audience
// (RLS already scopes to member_id = caller, but we filter by audience too).
func getMyEpochKeys(ctx context.Context, hc *http.Client, base, token, audienceID string) ([]audienceEpochKeyRow, error) {
	path := "/audience_epoch_keys?select=*&audience_id=eq." + q(audienceID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []audienceEpochKeyRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode epoch keys")
	}
	return rows, nil
}

// --- entry_audience_grants ---

func insertGrants(ctx context.Context, hc *http.Client, base, token string, rows []grantRow) error {
	if len(rows) == 0 {
		return nil
	}
	body, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/entry_audience_grants"), token,
		body, "resolution=merge-duplicates,return=minimal")
	return err
}

// getGrantsForAudience fetches every grant targeting an audience (author's own
// grants + member-visible grants, per the SELECT policy).
func getGrantsForAudience(ctx context.Context, hc *http.Client, base, token, audienceID string) ([]grantRow, error) {
	path := "/entry_audience_grants?select=*&audience_id=eq." + q(audienceID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []grantRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode grants")
	}
	return rows, nil
}

// getMyGrantsForAudience narrows the fetch to grants the caller authored — the
// set an author reconciles/cleans up on their own entries.
func getMyGrantsForAudience(ctx context.Context, hc *http.Client, base, token, audienceID, authorID string) ([]grantRow, error) {
	path := "/entry_audience_grants?select=*&audience_id=eq." + q(audienceID) + "&author_id=eq." + q(authorID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []grantRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode grants")
	}
	return rows, nil
}

func deleteGrant(ctx context.Context, hc *http.Client, base, token, entryID, audienceID string) error {
	path := "/entry_audience_grants?entry_id=eq." + q(entryID) + "&audience_id=eq." + q(audienceID)
	_, err := doJSON(ctx, hc, http.MethodDelete, endpoint(base, path), token, nil, "return=minimal")
	return err
}

// revokeGrant sets revoked + revoked_by (the §4a admin fast path). The
// column-guard trigger constrains the PATCH to exactly these columns.
func revokeGrant(ctx context.Context, hc *http.Client, base, token, entryID, audienceID, revokedBy string) error {
	path := "/entry_audience_grants?entry_id=eq." + q(entryID) + "&audience_id=eq." + q(audienceID)
	body, err := json.Marshal(map[string]any{"revoked": true, "revoked_by": revokedBy})
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPatch, endpoint(base, path), token, body, "return=minimal")
	return err
}

// --- shares ---

func upsertShare(ctx context.Context, hc *http.Client, base, token string, row shareRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/shares"), token,
		body, "resolution=merge-duplicates,return=minimal")
	return err
}

func getShares(ctx context.Context, hc *http.Client, base, token, audienceID string) ([]shareRow, error) {
	path := "/shares?select=*&audience_id=eq." + q(audienceID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []shareRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode shares")
	}
	return rows, nil
}

// --- entries (shared read path) ---

// getEntryByID fetches a single entry the caller can see (own row or a live
// grant). Used by the shared read path to pull granted entries for decryption.
func getEntriesByIDs(ctx context.Context, hc *http.Client, base, token string, ids []string) ([]sharedEntryRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	path := "/entries?select=*&id=in.(" + strings.Join(ids, ",") + ")"
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []sharedEntryRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode shared entries")
	}
	return rows, nil
}

// upsertSharedEntries writes v2 entry rows (payload + version + author_sig)
// idempotently, keyed by content-hash id. Ordering: this runs BEFORE grant
// inserts so the grants FK to entries is always satisfiable.
func upsertSharedEntries(ctx context.Context, hc *http.Client, base, token string, rows []sharedEntryRow) error {
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

// sharedEntryRow carries the sharing-specific entry columns (author_id/user_id,
// version, author_sig, contribution_status) that the base entryRow omits, for
// the shared read path.
// omitempty on contribution_status and deleted matters on WRITES: the owner's
// own push must not send contribution_status="" (would fail the CHECK) or
// deleted=false (would clobber a tombstone another device set), exactly as the
// base entryRow handles deleted. Reads still populate both fields normally.
type sharedEntryRow struct {
	ID                 string `json:"id"`
	UserID             string `json:"user_id"`
	Ciphertext         string `json:"ciphertext"`
	Nonce              string `json:"nonce"`
	Version            int    `json:"version"`
	AuthorSig          string `json:"author_sig"`
	ContributionStatus string `json:"contribution_status,omitempty"`
	Deleted            bool   `json:"deleted,omitempty"`
}

// patchContributionStatus flips a non-owner entry's approval status (§4/§5). The
// entries column-guard trigger restricts a non-author to this one column.
func patchContributionStatus(ctx context.Context, hc *http.Client, base, token, entryID, status string) error {
	path := "/entries?id=eq." + q(entryID)
	body, err := json.Marshal(map[string]string{"contribution_status": status})
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPatch, endpoint(base, path), token, body, "return=minimal")
	return err
}

// --- link_shares ---

// linkShareRow mirrors the link_shares table. valid_until is a pointer so a
// NULL (no upper bound) serializes as JSON null; token_hash / member_id and the
// wrapped blobs are opaque text, RLS-scoped to the creator on every verb.
type linkShareRow struct {
	ID               string  `json:"id"`
	AudienceID       string  `json:"audience_id"`
	TokenHash        string  `json:"token_hash"`
	MemberID         string  `json:"member_id"`
	WrappedIdentity  string  `json:"wrapped_identity"`
	IdentityNonce    string  `json:"identity_nonce"`
	SaltEnc          string  `json:"salt_enc"`
	TrustBundle      string  `json:"trust_bundle"`
	TrustBundleNonce string  `json:"trust_bundle_nonce"`
	CreatedBy        string  `json:"created_by"`
	ValidUntil       *string `json:"valid_until,omitempty"`
	Revoked          bool    `json:"revoked,omitempty"`
	CreatedAt        string  `json:"created_at,omitempty"`
}

func insertLinkShare(ctx context.Context, hc *http.Client, base, token string, row linkShareRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/link_shares"), token, body, "return=minimal")
	return err
}

// getLinkShares lists the caller's own links (RLS scopes to created_by = caller),
// newest first, for a list/revoke surface.
func getLinkShares(ctx context.Context, hc *http.Client, base, token string) ([]linkShareRow, error) {
	data, err := doJSON(ctx, hc, http.MethodGet,
		endpoint(base, "/link_shares?select=*&order=created_at.desc"), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []linkShareRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode link shares")
	}
	return rows, nil
}

// revokeLinkShare flips revoked on the link for one audience — the RPC's
// live-row check then denies it on the next call (§8), independent of the
// audience delete that follows.
func revokeLinkShare(ctx context.Context, hc *http.Client, base, token, audienceID string) error {
	path := "/link_shares?audience_id=eq." + q(audienceID)
	body, err := json.Marshal(map[string]any{"revoked": true})
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPatch, endpoint(base, path), token, body, "return=minimal")
	return err
}

// deleteAudience removes an audience the caller owns; ON DELETE CASCADE reaps
// its epochs, keys, grants, shares, and link_shares row (§8). The audiences
// DELETE policy confines this to link audiences.
func deleteAudience(ctx context.Context, hc *http.Client, base, token, audienceID string) error {
	path := "/audiences?id=eq." + q(audienceID)
	_, err := doJSON(ctx, hc, http.MethodDelete, endpoint(base, path), token, nil, "return=minimal")
	return err
}

// q percent-escapes a value for a PostgREST filter. User ids (JWT subs),
// audience ids and share ids are opaque strings that may contain characters
// needing escaping; entry ids are hex and need none but escaping is harmless.
func q(v string) string {
	return url.QueryEscape(v)
}
