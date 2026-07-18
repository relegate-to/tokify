package neonsync

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// fakePostgREST is a tiny in-memory stand-in for the Neon Data API covering the
// handful of sharing tables the service flow touches. It is deliberately minimal
// — enough to round-trip inserts and the eq./order filters the client emits —
// and does not enforce RLS (the client-side obligations are what's under test).
type fakePostgREST struct {
	epochs     []audienceEpochRow
	epochKeys  []audienceEpochKeyRow
	members    []audienceMemberRow
	shares     []shareRow
	grants     []grantRow
	audiences  []audienceRow
	identities []identityRow
	linkShares []linkShareRow
	entries    []sharedEntryRow
	operations []string
}

func (f *fakePostgREST) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/audiences", f.handleAudiences)
	mux.HandleFunc("/audience_epochs", f.handleEpochs)
	mux.HandleFunc("/audience_members", f.handleMembers)
	mux.HandleFunc("/audience_epoch_keys", f.handleEpochKeys)
	mux.HandleFunc("/shares", f.handleShares)
	mux.HandleFunc("/entry_audience_grants", f.handleGrants)
	mux.HandleFunc("/identities", f.handleIdentities)
	mux.HandleFunc("/link_shares", f.handleLinkShares)
	mux.HandleFunc("/entries", f.handleEntries)
	return mux
}

func (f *fakePostgREST) handleLinkShares(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		f.operations = append(f.operations, "link-share")
		var rows []linkShareRow
		decodeOneOrMany(r, &rows)
		f.linkShares = append(f.linkShares, rows...)
		w.WriteHeader(http.StatusCreated)
	case http.MethodPatch:
		aud := eqParam(r, "audience_id")
		for i := range f.linkShares {
			if f.linkShares[i].AudienceID == aud {
				f.linkShares[i].Revoked = true
			}
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSON(w, f.linkShares)
	}
}

func (f *fakePostgREST) handleEntries(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		f.operations = append(f.operations, "entries")
		var rows []sharedEntryRow
		decodeOneOrMany(r, &rows)
		for _, n := range rows { // upsert by id (merge-duplicates)
			replaced := false
			for i := range f.entries {
				if f.entries[i].ID == n.ID {
					f.entries[i] = n
					replaced = true
				}
			}
			if !replaced {
				f.entries = append(f.entries, n)
			}
		}
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, f.entries)
}

func (f *fakePostgREST) handleAudiences(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var rows []audienceRow
		decodeOneOrMany(r, &rows)
		f.audiences = append(f.audiences, rows...)
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, f.audiences)
}

func (f *fakePostgREST) handleEpochs(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var rows []audienceEpochRow
		decodeOneOrMany(r, &rows)
		f.epochs = append(f.epochs, rows...)
		f.bumpPointer(rows) // mimic the bump-pointer trigger
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, filterByAudience(f.epochs, eqParam(r, "audience_id"), func(e audienceEpochRow) string { return e.AudienceID }))
}

func (f *fakePostgREST) bumpPointer(rows []audienceEpochRow) {
	for i := range f.audiences {
		for _, e := range rows {
			if f.audiences[i].ID == e.AudienceID {
				f.audiences[i].CurrentEpoch = e.Epoch
			}
		}
	}
}

func (f *fakePostgREST) handleMembers(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var rows []audienceMemberRow
		decodeOneOrMany(r, &rows)
		// audience_members must be a plain insert (ON CONFLICT would apply the
		// SELECT policy as a WITH CHECK and break the creator's bootstrap row), so
		// a duplicate PRIMARY KEY is a hard 409 that the client swallows.
		for _, n := range rows {
			if f.hasMember(n.AudienceID, n.MemberID) {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write(
					[]byte(`{"code":"23505","message":"duplicate key value violates unique constraint \"audience_members_pkey\""}`),
				)
				return
			}
			f.members = append(f.members, n)
		}
		w.WriteHeader(http.StatusCreated)
		return
	}
	if r.Method == http.MethodPatch {
		aud := eqParam(r, "audience_id")
		member := eqParam(r, "member_id")
		var patch struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(readBody(r), &patch)
		for i := range f.members {
			if f.members[i].AudienceID == aud && f.members[i].MemberID == member {
				f.members[i].Status = patch.Status
			}
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, selectRows(r, f.members, "audience_id", func(m audienceMemberRow) string { return m.AudienceID }))
}

func (f *fakePostgREST) hasMember(audienceID, memberID string) bool {
	for _, m := range f.members {
		if m.AudienceID == audienceID && m.MemberID == memberID {
			return true
		}
	}
	return false
}

func (f *fakePostgREST) handleEpochKeys(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var rows []audienceEpochKeyRow
		decodeOneOrMany(r, &rows)
		// ON CONFLICT (any resolution) makes Postgres apply the SELECT policy
		// (member_id = auth.user_id()) as a WITH CHECK, which rejects an admin's
		// wrap to any OTHER member. Epoch-key inserts must therefore be plain.
		if preferResolution(r) != "" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"new row violates row-level security policy for table \"audience_epoch_keys\""}`))
			return
		}
		for _, n := range rows {
			if f.hasEpochKey(n) { // plain INSERT: a duplicate PK is a hard conflict.
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"message":"duplicate key value violates unique constraint \"audience_epoch_keys_pkey\""}`))
				return
			}
			f.epochKeys = append(f.epochKeys, n)
		}
		w.WriteHeader(http.StatusCreated)
	case http.MethodDelete:
		aud := eqParam(r, "audience_id")
		epoch := eqParam(r, "epoch")
		members := inParam(r, "member_id")
		kept := f.epochKeys[:0]
		for _, e := range f.epochKeys {
			if e.AudienceID == aud && strconv.Itoa(e.Epoch) == epoch && members[e.MemberID] {
				continue
			}
			kept = append(kept, e)
		}
		f.epochKeys = kept
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSON(w, f.epochKeys)
	}
}

// inParam parses a PostgREST `col=in.(a,b,c)` filter into a set.
func inParam(r *http.Request, col string) map[string]bool {
	raw := r.URL.Query().Get(col)
	raw = strings.TrimPrefix(raw, "in.(")
	raw = strings.TrimSuffix(raw, ")")
	out := map[string]bool{}
	for v := range strings.SplitSeq(raw, ",") {
		if v = strings.Trim(strings.TrimSpace(v), `"`); v != "" {
			out[v] = true
		}
	}
	return out
}

func (f *fakePostgREST) hasEpochKey(n audienceEpochKeyRow) bool {
	for _, e := range f.epochKeys {
		if e.AudienceID == n.AudienceID && e.Epoch == n.Epoch && e.MemberID == n.MemberID {
			return true
		}
	}
	return false
}

// preferResolution extracts the PostgREST conflict resolution (merge-duplicates
// or ignore-duplicates) from the Prefer header, or "" if unset.
func preferResolution(r *http.Request) string {
	for part := range strings.SplitSeq(r.Header.Get("Prefer"), ",") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(part), "resolution="); ok {
			return v
		}
	}
	return ""
}

func (f *fakePostgREST) handleShares(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var rows []shareRow
		decodeOneOrMany(r, &rows)
		f.shares = append(f.shares, rows...)
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, f.shares)
}

func (f *fakePostgREST) handleGrants(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		f.operations = append(f.operations, "grants")
		var rows []grantRow
		decodeOneOrMany(r, &rows)
		// Mimic grants_guard_update: sealing is randomized, so an insert over an
		// existing (entry_id, audience_id) always changes wrapped_dek and the
		// real schema rejects it — clients must delete-and-reinsert.
		for _, n := range rows {
			for _, g := range f.grants {
				if g.EntryID == n.EntryID && g.AudienceID == n.AudienceID {
					http.Error(w, "grant UPDATE may only change revoked / revoked_by", http.StatusConflict)
					return
				}
			}
		}
		f.grants = append(f.grants, rows...)
		w.WriteHeader(http.StatusCreated)
	case http.MethodDelete:
		f.deleteGrant(eqParam(r, "entry_id"), eqParam(r, "audience_id"))
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSON(w, f.grants)
	}
}

func (f *fakePostgREST) deleteGrant(entryID, audienceID string) {
	kept := f.grants[:0]
	for _, g := range f.grants {
		if g.EntryID == entryID && g.AudienceID == audienceID {
			continue
		}
		kept = append(kept, g)
	}
	f.grants = kept
}

func (f *fakePostgREST) handleIdentities(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var rows []identityRow
		decodeOneOrMany(r, &rows)
		f.identities = append(f.identities, rows...)
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, selectRows(r, f.identities, "user_id", func(i identityRow) string { return i.UserID }))
}

// filterByAudience returns rows whose key equals want, or all rows when want is
// empty — the eq. filter shape the client emits.
func filterByAudience[T any](rows []T, want string, key func(T) string) []T {
	if want == "" {
		return rows
	}
	out := make([]T, 0, len(rows))
	for _, row := range rows {
		if key(row) == want {
			out = append(out, row)
		}
	}
	return out
}

func decodeOneOrMany[T any](r *http.Request, out *[]T) {
	body := readBody(r)
	if strings.HasPrefix(strings.TrimSpace(string(body)), "[") {
		_ = json.Unmarshal(body, out)
		return
	}
	var one T
	if json.Unmarshal(body, &one) == nil {
		*out = append(*out, one)
	}
}

func readBody(r *http.Request) []byte {
	body, _ := io.ReadAll(r.Body)
	return body
}

func eqParam(r *http.Request, key string) string {
	v := r.URL.Query().Get(key)
	return strings.TrimPrefix(v, "eq.")
}

// paramMatch reports whether v satisfies the PostgREST filter on the request's
// `key` query param, supporting the eq. and in.(...) forms the client emits (and
// treating an absent filter as "match all").
func paramMatch(r *http.Request, key, v string) bool {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return true
	}
	if rest, ok := strings.CutPrefix(raw, "in.("); ok {
		rest = strings.TrimSuffix(rest, ")")
		for item := range strings.SplitSeq(rest, ",") {
			if strings.Trim(strings.TrimSpace(item), `"`) == v {
				return true
			}
		}
		return false
	}
	return strings.TrimPrefix(raw, "eq.") == v
}

// selectRows filters rows by the eq./in. filter on one column — the fake's GET
// equivalent of an RLS-less PostgREST read.
func selectRows[T any](r *http.Request, rows []T, key string, col func(T) string) []T {
	out := make([]T, 0, len(rows))
	for _, row := range rows {
		if paramMatch(r, key, col(row)) {
			out = append(out, row)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// newFlowService builds a Service pointed at a fake server, with a temp settings
// dir so the pin store is isolated. It bypasses keychain by not exercising
// Unlock/Lock — tests drive the session-taking internals directly.
func newFlowService(t *testing.T, srv *httptest.Server) *Service {
	t.Helper()
	dir := t.TempDir()
	return &Service{
		http:     srv.Client(),
		settings: Settings{DataURL: srv.URL, Enabled: true},
		path:     dir + "/neonsync.json",
		pins:     newPinStore(dir + "/neonsync.json"),
	}
}

// TestAudienceLifecycleFlow drives CreateAudience -> SetShareFilter ->
// reconcileAudience against the fake server using an in-memory session, then
// verifies the produced grant is a real, verifiable wrap of the entry DEK to the
// signed current epoch key. This exercises the client-side obligations end to
// end without touching Keychain or the network probe.
func TestAudienceLifecycleFlow(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	svc := newFlowService(t, srv)
	ctx := context.Background()

	// Build an admin identity and DEK, and a session bound to them.
	id, err := sharing.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	dek, _ := GenerateDEK()
	userID := "admin-sub"
	sess := &sharingSession{svc: svc, base: srv.URL, token: "tok", userID: userID, id: id, dek: dek}

	// Publish + pin ourselves so our own admin epoch signatures verify on reconcile.
	fake.identities = append(fake.identities, identityRow{
		UserID: userID, PubEnc: b64(id.Public().EncPub), PubSig: b64(id.Public().SigPub),
	})
	if perr := svc.pins.Pin(userID, sharing.Fingerprint(id.Public())); perr != nil {
		t.Fatal(perr)
	}

	// Bootstrap audience (mirrors CreateAudience without needing a token/keychain).
	audienceID := "aud-1"
	fake.audiences = append(fake.audiences, audienceRow{ID: audienceID, CreatedBy: userID})
	fake.members = append(fake.members, audienceMemberRow{AudienceID: audienceID, MemberID: userID, Role: "admin"})

	epochPriv, err := sharing.GenerateEpochKeypair()
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.publishEpoch(ctx, sess, audienceID, 1, "", epochPriv); err != nil {
		t.Fatal(err)
	}
	if err = svc.wrapEpochToMembers(ctx, sess, audienceID, 1, epochPriv.Bytes(),
		[]memberKey{{id: userID, encPub: id.Public().EncPub}}); err != nil {
		t.Fatal(err)
	}

	// The epoch chain must now verify against the pinned admin key.
	verified, err := svc.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		t.Fatalf("epoch chain did not verify: %v", err)
	}
	if len(verified) != 1 || verified[0].Epoch != 1 {
		t.Fatalf("unexpected verified epochs: %+v", verified)
	}

	// Set a filter matching our test entry.
	if err = svc.writeShare(ctx, sess, audienceID, "share-1", 1, epochPriv.PublicKey().Bytes(),
		shareFilter{Projects: []string{"tokify"}}); err != nil {
		t.Fatal(err)
	}

	// One completed local entry in-scope.
	start := time.Date(2026, 7, 12, 9, 0, 0, 0, time.Local)
	end := start.Add(time.Hour)
	a := models.Activity{Project: "tokify", Description: "ship it", StartTime: start, EndTime: &end}
	entryID := EntryID(dek, canonicalize(a))
	localByID := map[string]models.Activity{entryID: a}

	if err = svc.reconcileAudience(ctx, sess, audienceID, localByID, time.Now()); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	// Exactly one grant was inserted, on the current epoch, for our entry.
	if len(fake.grants) != 1 {
		t.Fatalf("want 1 grant, got %d", len(fake.grants))
	}
	g := fake.grants[0]
	if g.EntryID != entryID || g.Epoch != 1 || g.AuthorID != userID {
		t.Fatalf("unexpected grant: %+v", g)
	}

	// The grant's wrapped DEK really unwraps to the entry DEK under the epoch
	// private key with the correct GrantAAD, and its signature verifies.
	wrapped, err := unb64(g.WrappedDEK)
	if err != nil {
		t.Fatal(err)
	}
	grantAAD := sharing.GrantAAD{EntryID: entryID, AudienceID: audienceID, Epoch: 1}
	gotDEK, err := sharing.UnwrapDEKFromEpoch(epochPriv.Bytes(), wrapped, grantAAD)
	if err != nil {
		t.Fatalf("grant wrapped_dek did not unwrap: %v", err)
	}
	wantDEK, _ := sharing.DeriveEntryDEK(dek, entryID)
	if string(gotDEK) != string(wantDEK) {
		t.Fatal("unwrapped DEK does not match the derived entry DEK")
	}
	sig, _ := unb64(g.AuthorSig)
	ok, err := sharing.VerifyGrantSig(id.Public().SigPub, grantAAD, wrapped, sig)
	if err != nil || !ok {
		t.Fatalf("grant signature did not verify (ok=%v err=%v)", ok, err)
	}

	// Reconciling again is idempotent: the grant already exists on the current
	// epoch and is live, so no duplicate is inserted.
	if err = svc.reconcileAudience(ctx, sess, audienceID, localByID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(fake.grants) != 1 {
		t.Fatalf("reconcile not idempotent: %d grants", len(fake.grants))
	}

	// A soft-revoked grant whose entry still matches the filter is re-granted
	// via delete-and-reinsert (the update guard forbids mutating a grant) and
	// ends up live on the current epoch — not deleted again in the same pass.
	fake.grants[0].Revoked = true
	if err = svc.reconcileAudience(ctx, sess, audienceID, localByID, time.Now()); err != nil {
		t.Fatalf("re-grant after soft-revoke failed: %v", err)
	}
	if len(fake.grants) != 1 || fake.grants[0].Revoked || fake.grants[0].Epoch != 1 {
		t.Fatalf("revoked grant not re-granted live: %+v", fake.grants)
	}

	// Now the entry falls out of scope (empty local set): the stale grant is
	// deleted (crypto-plane cleanup). The fake honors DELETE by clearing matches.
	if err = svc.reconcileAudience(ctx, sess, audienceID, map[string]models.Activity{}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(fake.grants) != 0 {
		t.Fatalf("stale grant not cleaned up: %d grants remain", len(fake.grants))
	}
}

// TestWrapEpochToMembersReWrap guards the invite path: wrapping is a plain INSERT
// (ON CONFLICT would make Postgres apply the SELECT policy as a WITH CHECK and
// reject an admin's wrap to another member), and re-wrapping an existing
// (audience, epoch, member) must still succeed because the wrap deletes the stale
// row first. This covers re-inviting a previously removed member, whose old-epoch
// keys survive the removal.
func TestWrapEpochToMembersReWrap(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	svc := newFlowService(t, srv)
	ctx := context.Background()

	id, err := sharing.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	dek, _ := GenerateDEK()
	sess := &sharingSession{svc: svc, base: srv.URL, token: "tok", userID: "admin-sub", id: id, dek: dek}

	epochPriv, err := sharing.GenerateEpochKeypair()
	if err != nil {
		t.Fatal(err)
	}
	member := []memberKey{{id: "member-sub", encPub: id.Public().EncPub}}

	if err = svc.wrapEpochToMembers(ctx, sess, "aud-1", 1, epochPriv.Bytes(), member); err != nil {
		t.Fatal(err)
	}
	// Second wrap of the same (audience, epoch, member): must succeed as a no-op.
	if err = svc.wrapEpochToMembers(ctx, sess, "aud-1", 1, epochPriv.Bytes(), member); err != nil {
		t.Fatalf("re-wrap of existing epoch key failed: %v", err)
	}
	if len(fake.epochKeys) != 1 {
		t.Fatalf("want 1 epoch key row after re-wrap, got %d", len(fake.epochKeys))
	}
}

// TestInsertEpochKeysIdempotent guards re-inviting a previously removed member:
// their old-epoch key row can outlive the delete-first (e.g. an RLS/schema quirk
// on the live DB), so the wrap's batch INSERT hits the (audience, epoch, member)
// PK. That is not a real conflict — the epoch key is fixed per epoch number, so
// the surviving wrap is still valid — and the insert must recover by swallowing
// the duplicate rather than failing the whole re-invite.
func TestInsertEpochKeysIdempotent(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	ctx := context.Background()

	stale := audienceEpochKeyRow{AudienceID: "aud-1", Epoch: 1, MemberID: "m1", WrappedEpochPrivkey: "old"}
	if err := insertEpochKeys(ctx, http.DefaultClient, srv.URL, "tok", []audienceEpochKeyRow{stale}); err != nil {
		t.Fatalf("seed insert failed: %v", err)
	}

	// A batch re-wrapping the surviving row alongside a brand-new one: the batch
	// POST 409s on the stale row, and the row-by-row fallback must swallow that
	// duplicate while still landing the new member's wrap.
	batch := []audienceEpochKeyRow{
		{AudienceID: "aud-1", Epoch: 1, MemberID: "m1", WrappedEpochPrivkey: "new"},
		{AudienceID: "aud-1", Epoch: 1, MemberID: "m2", WrappedEpochPrivkey: "new"},
	}
	if err := insertEpochKeys(ctx, http.DefaultClient, srv.URL, "tok", batch); err != nil {
		t.Fatalf("re-wrap over a surviving row must succeed, got: %v", err)
	}
	if !fake.hasEpochKey(audienceEpochKeyRow{AudienceID: "aud-1", Epoch: 1, MemberID: "m2"}) {
		t.Fatal("new member wrap was not inserted after the duplicate")
	}
	if got := len(fake.epochKeys); got != 2 {
		t.Fatalf("want 2 epoch key rows (m1 kept, m2 added), got %d", got)
	}
}

// TestInviteThenAcceptStatus guards the invite handshake at the transport seam:
// an invited member is planted as 'invited' and the accept flip (updateMemberStatus)
// moves that same row to 'active'. The RLS guard that confines a non-admin to this
// exact transition is enforced in the schema, not the fake.
func TestInviteThenAcceptStatus(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	ctx := context.Background()

	invited := audienceMemberRow{AudienceID: "aud-1", MemberID: "member-sub", Role: "member", Status: "invited"}
	if err := insertMember(ctx, srv.Client(), srv.URL, "tok", invited); err != nil {
		t.Fatal(err)
	}
	if len(fake.members) != 1 || fake.members[0].Status != "invited" {
		t.Fatalf("want one invited member, got %+v", fake.members)
	}

	if err := updateMemberStatus(ctx, srv.Client(), srv.URL, "tok", "aud-1", "member-sub", "active"); err != nil {
		t.Fatalf("accept flip failed: %v", err)
	}
	if len(fake.members) != 1 || fake.members[0].Status != "active" {
		t.Fatalf("want member active after accept, got %+v", fake.members)
	}
}

// TestInsertMemberIdempotent guards AddMember's recoverability: a retry after a
// partial failure (member row already written, epoch-key wrap aborted) must not
// fail on the audience_members primary key.
func TestInsertMemberIdempotent(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	ctx := context.Background()

	row := audienceMemberRow{AudienceID: "aud-1", MemberID: "member-sub", Role: "member"}
	if err := insertMember(ctx, srv.Client(), srv.URL, "tok", row); err != nil {
		t.Fatal(err)
	}
	if err := insertMember(ctx, srv.Client(), srv.URL, "tok", row); err != nil {
		t.Fatalf("re-insert of existing member failed: %v", err)
	}
	if len(fake.members) != 1 {
		t.Fatalf("want 1 member row after re-insert, got %d", len(fake.members))
	}
}
