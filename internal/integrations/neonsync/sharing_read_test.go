package neonsync

import (
	"context"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

type sharingUser struct {
	svc  *Service
	sess *sharingSession
}

func newSharingUser(t *testing.T, fake *fakePostgREST, srv *httptest.Server, userID string) *sharingUser {
	t.Helper()
	svc := newFlowService(t, srv)
	id, err := sharing.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	dek, err := GenerateDEK()
	if err != nil {
		t.Fatal(err)
	}
	fake.identities = append(fake.identities, identityRow{
		UserID: userID, PubEnc: b64(id.Public().EncPub), PubSig: b64(id.Public().SigPub),
	})
	return &sharingUser{
		svc:  svc,
		sess: &sharingSession{svc: svc, base: srv.URL, token: "tok", userID: userID, id: id, dek: dek},
	}
}

func (u *sharingUser) pin(t *testing.T, others ...*sharingUser) {
	t.Helper()
	for _, o := range append(others, u) {
		if err := u.svc.pins.Pin(o.sess.userID, sharing.Fingerprint(o.sess.id.Public())); err != nil {
			t.Fatal(err)
		}
	}
}

// share pushes the author's local entries and reconciles their grants, the way
// a sync does.
func (u *sharingUser) share(t *testing.T, audienceID string, acts ...models.Activity) map[string]models.Activity {
	t.Helper()
	local := make(map[string]models.Activity, len(acts))
	for _, a := range acts {
		local[EntryID(u.sess.dek, canonicalize(a))] = a
	}
	ctx := context.Background()
	if err := u.svc.pushSharedEntries(ctx, u.sess, local); err != nil {
		t.Fatal(err)
	}
	if err := u.svc.reconcileAudience(ctx, u.sess, audienceID, local, time.Now()); err != nil {
		t.Fatal(err)
	}
	return local
}

func (u *sharingUser) list(t *testing.T) []string {
	t.Helper()
	entries, err := u.svc.listSharedEntries(context.Background(), u.sess, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Activity.Description
	}
	slices.Sort(out)
	return out
}

func sharedActivity(description string, hour int) models.Activity {
	start := time.Date(2026, 7, 12, hour, 0, 0, 0, time.Local)
	end := start.Add(time.Hour)
	return models.Activity{Project: "tokify", Description: description, StartTime: start, EndTime: &end}
}

func requested(fake *fakePostgREST, prefix string) bool {
	return slices.ContainsFunc(fake.requests, func(r string) bool { return strings.HasPrefix(r, prefix) })
}

func TestSharedReadIsIncremental(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	ctx := context.Background()

	alice := newSharingUser(t, fake, srv, "alice")
	bob := newSharingUser(t, fake, srv, "bob")
	alice.pin(t, bob)
	bob.pin(t, alice)

	audienceID := "aud-1"
	fake.audiences = append(fake.audiences, audienceRow{ID: audienceID, CreatedBy: "alice"})
	fake.members = append(fake.members,
		audienceMemberRow{AudienceID: audienceID, MemberID: "alice", Role: "admin"},
		audienceMemberRow{AudienceID: audienceID, MemberID: "bob", Role: "member"},
	)
	epochPriv, err := sharing.GenerateEpochKeypair()
	if err != nil {
		t.Fatal(err)
	}
	if err = alice.svc.publishEpoch(ctx, alice.sess, audienceID, 1, "", epochPriv); err != nil {
		t.Fatal(err)
	}
	if err = alice.svc.wrapEpochToMembers(ctx, alice.sess, audienceID, 1, epochPriv.Bytes(), []memberKey{
		{id: "alice", encPub: alice.sess.id.Public().EncPub},
		{id: "bob", encPub: bob.sess.id.Public().EncPub},
	}); err != nil {
		t.Fatal(err)
	}
	if err = alice.svc.writeShare(ctx, alice.sess, audienceID, "share-1", 1, epochPriv.PublicKey().Bytes(),
		shareFilter{Projects: []string{"tokify"}}); err != nil {
		t.Fatal(err)
	}

	first, second := sharedActivity("first", 9), sharedActivity("second", 11)
	alice.share(t, audienceID, first)
	if got := bob.list(t); !slices.Equal(got, []string{"first"}) {
		t.Fatalf("first read: got %v", got)
	}

	fake.requests = nil
	if got := bob.list(t); !slices.Equal(got, []string{"first"}) {
		t.Fatalf("idle read: got %v", got)
	}
	if requested(fake, "GET /entry_audience_grants") || requested(fake, "GET /entries") ||
		requested(fake, "POST /rpc/") || requested(fake, "GET /audience_epochs") {
		t.Fatalf("idle poll re-read shared data: %v", fake.requests)
	}

	fake.requests = nil
	local := alice.share(t, audienceID, first, second)
	fake.requests = nil
	if got := bob.list(t); !slices.Equal(got, []string{"first", "second"}) {
		t.Fatalf("after a new grant: got %v", got)
	}
	if !requested(fake, "POST /rpc/sharing_audience_delta") || requested(fake, "GET /entry_audience_grants") {
		t.Fatalf("new grant should be read as a delta: %v", fake.requests)
	}

	alice.share(t, audienceID, second)
	if got := bob.list(t); !slices.Equal(got, []string{"second"}) {
		t.Fatalf("after a grant removal: got %v", got)
	}

	fake.untracked = true
	fake.requests = nil
	if got := bob.list(t); !slices.Equal(got, []string{"second"}) {
		t.Fatalf("untracked server: got %v", got)
	}
	if !requested(fake, "GET /entry_audience_grants") {
		t.Fatalf("untracked server should get the full walk: %v", fake.requests)
	}
	fake.untracked = false

	fake.bump(audienceID, true)
	fake.requests = nil
	if got := bob.list(t); !slices.Equal(got, []string{"second"}) {
		t.Fatalf("after a structural change: got %v", got)
	}
	if !requested(fake, "GET /audience_epochs") || !requested(fake, "GET /entry_audience_grants") {
		t.Fatalf("structural change should re-read the audience: %v", fake.requests)
	}

	for id, act := range local {
		if act.Description == "second" {
			fake.setEntryDeleted(id)
		}
	}
	if got := bob.list(t); len(got) != 0 {
		t.Fatalf("after a tombstone: got %v", got)
	}
}

func TestSharedReadResetsWhenTrustChanges(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	u := newSharingUser(t, fake, srv, "bob")
	u.svc.shared = sharedReadState{
		userID:    "bob",
		audiences: map[string]*audienceView{"gone": {seq: 1, entries: map[string]sharedView{}}},
	}
	u.svc.shared.trust, _ = u.svc.pins.trustState()
	if err := u.svc.pins.Pin("alice", "fp"); err != nil {
		t.Fatal(err)
	}
	if got := u.list(t); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
	if _, ok := u.svc.shared.audiences["gone"]; ok {
		t.Fatal("cached view survived a trust change")
	}
}
