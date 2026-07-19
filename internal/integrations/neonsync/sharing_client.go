package neonsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
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
	// DisplayName is the self-chosen human name published for the roster. omitempty
	// so a name-less re-publish (e.g. an email_hash backfill) never clobbers a name
	// already set — only an explicit PublishDisplayName writes it.
	DisplayName string `json:"display_name,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
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
	// Status is 'invited' (admin planted the row) or 'active' (accepted). omitempty
	// on insert so the creator's bootstrap self-admin row takes the server DEFAULT
	// 'active'; an invite sends 'invited' explicitly.
	Status string `json:"status,omitempty"`
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

// audienceNameRow mirrors the audience_names table: one encrypted team name per
// audience, sealed to the epoch key. audience_id is the PK so an upsert renames
// in place.
type audienceNameRow struct {
	AudienceID     string `json:"audience_id"`
	Epoch          int    `json:"epoch"`
	NameCiphertext string `json:"name_ciphertext"`
	CreatedBy      string `json:"created_by"`
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

// getIdentities fetches published identities for many users in one request,
// keyed by user_id — the batched form of getIdentity that a roster or an author
// list uses instead of a per-user round-trip. A user with no published identity
// is simply absent from the map; empty in, empty out.
func getIdentities(ctx context.Context, hc *http.Client, base, token string, userIDs []string) (map[string]identityRow, error) {
	out := make(map[string]identityRow, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	quoted := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, id := range userIDs {
		if _, dup := seen[id]; dup || id == "" {
			continue
		}
		seen[id] = struct{}{}
		quoted = append(quoted, q(id))
	}
	path := "/identities?select=*&user_id=in.(" + strings.Join(quoted, ",") + ")"
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []identityRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode identities")
	}
	for _, r := range rows {
		out[r.UserID] = r
	}
	return out, nil
}

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

// patchPinsColumns writes the wrapped_pins + pins_nonce columns onto the
// caller's user_keys row (RLS-scoped to the JWT owner), syncing the fingerprint
// pin store across the user's own devices.
func patchPinsColumns(ctx context.Context, hc *http.Client, base, token, wrappedPins, pinsNonce string) error {
	body, err := json.Marshal(map[string]string{
		"wrapped_pins": wrappedPins,
		"pins_nonce":   pinsNonce,
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
	// Plain INSERT, and swallow a duplicate. This can't use ON CONFLICT: that would
	// make Postgres apply the SELECT policy (sharing_is_member) as a WITH CHECK on
	// the inserted row, which the audience creator's bootstrap self-admin insert
	// fails (they are not a member yet — that row is what makes them one). A
	// duplicate instead means the member is already present, so AddMember stays
	// idempotent (retry after a partial failure, or a re-invite) with the existing
	// role left untouched.
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_members"), token,
		body, "return=minimal")
	if isUniqueViolation(err) {
		return nil
	}
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

// getMembersByAudiences fetches members for many audiences in one request,
// grouped by audience_id — the batched form of getMembers so a roster over N
// teams costs one round-trip, not N. Empty in, empty map out.
func getMembersByAudiences(
	ctx context.Context,
	hc *http.Client,
	base, token string,
	audienceIDs []string,
) (map[string][]audienceMemberRow, error) {
	out := make(map[string][]audienceMemberRow, len(audienceIDs))
	if len(audienceIDs) == 0 {
		return out, nil
	}
	quoted := make([]string, len(audienceIDs))
	for i, id := range audienceIDs {
		quoted[i] = q(id)
	}
	path := "/audience_members?select=*&audience_id=in.(" + strings.Join(quoted, ",") + ")"
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []audienceMemberRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode members")
	}
	for _, r := range rows {
		out[r.AudienceID] = append(out[r.AudienceID], r)
	}
	return out, nil
}

func deleteMember(ctx context.Context, hc *http.Client, base, token, audienceID, memberID string) error {
	path := "/audience_members?audience_id=eq." + q(audienceID) + "&member_id=eq." + q(memberID)
	_, err := doJSON(ctx, hc, http.MethodDelete, endpoint(base, path), token, nil, "return=minimal")
	return err
}

// updateMemberStatus PATCHes one member row's status — the invitee's accept
// ('invited' -> 'active'). RLS + the column-guard trigger confine a non-admin to
// exactly that flip on their own row.
func updateMemberStatus(ctx context.Context, hc *http.Client, base, token, audienceID, memberID, status string) error {
	path := "/audience_members?audience_id=eq." + q(audienceID) + "&member_id=eq." + q(memberID)
	body, err := json.Marshal(map[string]string{"status": status})
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPatch, endpoint(base, path), token, body, "return=minimal")
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
	// Plain INSERT, NO conflict resolution. An admin wraps epoch keys to OTHER
	// members, whose rows the admin cannot see (SELECT policy is member_id =
	// auth.user_id()). Postgres applies a table's SELECT policy as an extra
	// WITH CHECK on any INSERT that carries ON CONFLICT (WCO_RLS_CONFLICT_CHECK) —
	// so merge-/ignore-duplicates both fail here with an RLS violation the moment
	// member_id != the caller. The caller deletes the target rows first so the
	// batch normally lands clean.
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_epoch_keys"), token,
		body, "return=minimal")
	if !isUniqueViolation(err) {
		return err
	}
	// A surviving (audience, epoch, member) row — e.g. re-inviting a member whose
	// old-epoch keys outlived the delete-first — is not a real conflict: the epoch
	// private key is fixed per epoch number, so any existing wrap already decrypts
	// to the same key. Re-insert row by row and swallow the duplicates, so one
	// stale row can't fail the whole batch (an ON-CONFLICT retry can't be used —
	// see above).
	return insertEpochKeysIdempotent(ctx, hc, base, token, rows)
}

// insertEpochKeysIdempotent inserts epoch-key rows one at a time, treating a
// duplicate-PK conflict as success. Used only as the fallback when a batch
// insert hits an already-present wrap; the happy path stays a single request.
func insertEpochKeysIdempotent(ctx context.Context, hc *http.Client, base, token string, rows []audienceEpochKeyRow) error {
	for i := range rows {
		body, err := json.Marshal([]audienceEpochKeyRow{rows[i]})
		if err != nil {
			return err
		}
		_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_epoch_keys"), token,
			body, "return=minimal")
		if err != nil && !isUniqueViolation(err) {
			return err
		}
	}
	return nil
}

// deleteEpochKeys removes the (audience, epoch, member) wraps for the given
// members so a subsequent insert can't collide. Admin-gated (DELETE policy is
// sharing_is_admin); a no-op when there is nothing to delete.
func deleteEpochKeys(ctx context.Context, hc *http.Client, base, token, audienceID string, epoch int, memberIDs []string) error {
	if len(memberIDs) == 0 {
		return nil
	}
	quoted := make([]string, len(memberIDs))
	for i, m := range memberIDs {
		quoted[i] = q(m)
	}
	path := "/audience_epoch_keys?audience_id=eq." + q(audienceID) +
		"&epoch=eq." + strconv.Itoa(epoch) +
		"&member_id=in.(" + strings.Join(quoted, ",") + ")"
	_, err := doJSON(ctx, hc, http.MethodDelete, endpoint(base, path), token, nil, "return=minimal")
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

// --- audience names ---

func upsertAudienceName(ctx context.Context, hc *http.Client, base, token string, row audienceNameRow) error {
	body, err := json.Marshal(row)
	if err != nil {
		return err
	}
	_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/audience_names"), token,
		body, "resolution=merge-duplicates,return=minimal")
	return err
}

// getAudienceName returns the audience's name rows (zero or one — audience_id is
// the PK). Mirrors getShares: an empty slice means no name is published, which
// the caller treats as "no shared name", not an error.
func getAudienceName(ctx context.Context, hc *http.Client, base, token, audienceID string) ([]audienceNameRow, error) {
	path := "/audience_names?select=*&audience_id=eq." + q(audienceID)
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, path), token, nil, "")
	if err != nil {
		return nil, err
	}
	var rows []audienceNameRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return nil, gerrors.Wrap(uerr, "decode audience names")
	}
	return rows, nil
}

func deleteAudienceName(ctx context.Context, hc *http.Client, base, token, audienceID string) error {
	path := "/audience_names?audience_id=eq." + q(audienceID)
	_, err := doJSON(ctx, hc, http.MethodDelete, endpoint(base, path), token, nil, "return=minimal")
	return err
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
