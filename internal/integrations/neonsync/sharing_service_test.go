package neonsync

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
		f.members = append(f.members, rows...)
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, f.members)
}

func (f *fakePostgREST) handleEpochKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var rows []audienceEpochKeyRow
		decodeOneOrMany(r, &rows)
		f.epochKeys = append(f.epochKeys, rows...)
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, f.epochKeys)
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
	writeJSON(w, filterByAudience(f.identities, eqParam(r, "user_id"), func(i identityRow) string { return i.UserID }))
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
