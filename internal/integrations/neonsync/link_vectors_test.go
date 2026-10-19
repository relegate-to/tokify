package neonsync

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// testdata/link-vectors.json is a capability link as a browser holder sees it:
// the URL-fragment secret and a response shaped exactly like sharing_link_fetch,
// minted by the real sender path. The tokify.to share viewer decrypts the same
// file in its own tests. Seals use fresh randomness, so the file is checked by
// decrypting it rather than byte comparison; regenerate with
// `go test ./internal/integrations/neonsync -run LinkVectors -update` and copy
// it to the website.

type linkVectors struct {
	Secret       string            `json:"secret"`
	LinkToken    string            `json:"link_token"`
	TokenHash    string            `json:"token_hash"`
	KEKHex       string            `json:"kek_hex"`
	SenderSigPub string            `json:"sender_sig_pub_b64"`
	RPC          linkFetchResponse `json:"rpc"`
	Entries      []canonicalEntry  `json:"entries"`
}

// linkFetchResponse mirrors the JSON object sharing_link_fetch returns.
type linkFetchResponse struct {
	AudienceID       string           `json:"audience_id"`
	MemberID         string           `json:"member_id"`
	WrappedIdentity  string           `json:"wrapped_identity"`
	IdentityNonce    string           `json:"identity_nonce"`
	SaltEnc          string           `json:"salt_enc"`
	TrustBundle      string           `json:"trust_bundle"`
	TrustBundleNonce string           `json:"trust_bundle_nonce"`
	EpochKeys        []linkFetchEpoch `json:"epoch_keys"`
	Entries          []linkFetchEntry `json:"entries"`
}

type linkFetchEpoch struct {
	Epoch               int    `json:"epoch"`
	WrappedEpochPrivkey string `json:"wrapped_epoch_privkey"`
}

type linkFetchEntry struct {
	ID         string `json:"id"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
	Version    int    `json:"version"`
	AuthorSig  string `json:"author_sig"`
	AuthorID   string `json:"author_id"`
	GrantEpoch int    `json:"grant_epoch"`
	WrappedDEK string `json:"wrapped_dek"`
}

func TestLinkVectors(t *testing.T) {
	path := filepath.Join("testdata", "link-vectors.json")
	if *updateVectors {
		b, err := json.MarshalIndent(buildLinkVectors(t), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (regenerate with -update)", err)
	}
	var v linkVectors
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	checkLinkVectors(t, v)
}

func buildLinkVectors(t *testing.T) linkVectors {
	t.Helper()
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	svc := newFlowService(t, srv)
	ctx := context.Background()

	sender, err := sharing.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	dek, _ := GenerateDEK()
	userID := "sender-sub"
	sess := &sharingSession{svc: svc, base: srv.URL, token: "tok", userID: userID, id: sender, dek: dek}
	fake.identities = append(fake.identities, identityRow{
		UserID: userID, PubEnc: b64(sender.Public().EncPub), PubSig: b64(sender.Public().SigPub),
	})
	if perr := svc.pins.Pin(userID, sharing.Fingerprint(sender.Public())); perr != nil {
		t.Fatal(perr)
	}

	audienceID := "link-aud"
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
		[]memberKey{{id: userID, encPub: sender.Public().EncPub}}); err != nil {
		t.Fatal(err)
	}
	projects := []string{"tokify", "Clients/ÆØÅ"}
	if err = svc.writeShare(ctx, sess, audienceID, "share-1", 1, epochPriv.PublicKey().Bytes(),
		shareFilter{Projects: projects}); err != nil {
		t.Fatal(err)
	}

	localByID := map[string]models.Activity{}
	start := time.Date(2026, 10, 1, 9, 30, 0, 0, time.Local)
	for i, c := range []struct{ desc, project string }{
		{"Write plan", "tokify"},
		{`Fix <script> & "quotes" in names`, "tokify"},
		{"Café review — naïve résumé 🔑", "Clients/ÆØÅ"},
		{"Not in the slice", "personal"},
	} {
		s := start.Add(time.Duration(i) * 3 * time.Hour)
		e := s.Add(95 * time.Minute)
		act := models.Activity{Description: c.desc, Project: c.project, StartTime: s, EndTime: &e}
		localByID[EntryID(dek, canonicalize(act))] = act
	}

	ls, err := svc.provisionLinkRecipient(ctx, sess, audienceID, localByID, 0)
	if err != nil {
		t.Fatalf("provisionLinkRecipient: %v", err)
	}
	link := fake.linkShares[0]
	secret, err := base64.RawURLEncoding.DecodeString(ls.Secret)
	if err != nil {
		t.Fatal(err)
	}
	salt, _ := unb64(link.SaltEnc)

	v := linkVectors{
		Secret:       ls.Secret,
		LinkToken:    deriveLinkToken(secret),
		TokenHash:    link.TokenHash,
		KEKHex:       hex.EncodeToString(deriveLinkKEK(secret, salt)),
		SenderSigPub: b64(sender.Public().SigPub),
		RPC: linkFetchResponse{
			AudienceID: link.AudienceID, MemberID: link.MemberID,
			WrappedIdentity: link.WrappedIdentity, IdentityNonce: link.IdentityNonce, SaltEnc: link.SaltEnc,
			TrustBundle: link.TrustBundle, TrustBundleNonce: link.TrustBundleNonce,
			EpochKeys: []linkFetchEpoch{}, Entries: []linkFetchEntry{},
		},
	}
	for _, k := range fake.epochKeys {
		if k.AudienceID == audienceID && k.MemberID == link.MemberID {
			v.RPC.EpochKeys = append(v.RPC.EpochKeys, linkFetchEpoch{Epoch: k.Epoch, WrappedEpochPrivkey: k.WrappedEpochPrivkey})
		}
	}
	for _, g := range fake.grants {
		for _, e := range fake.entries {
			if e.ID != g.EntryID || g.AudienceID != audienceID {
				continue
			}
			v.RPC.Entries = append(v.RPC.Entries, linkFetchEntry{
				ID: e.ID, Ciphertext: e.Ciphertext, Nonce: e.Nonce, Version: e.Version, AuthorSig: e.AuthorSig,
				AuthorID: e.UserID, GrantEpoch: g.Epoch, WrappedDEK: g.WrappedDEK,
			})
			act := localByID[e.ID]
			v.Entries = append(v.Entries, canonicalEntry{
				Description: act.Description, Project: act.Project,
				Start: act.StartTime.Format(syncTimeLayout), End: act.EndTime.Format(syncTimeLayout),
			})
		}
	}
	if len(v.RPC.Entries) != 3 {
		t.Fatalf("want the 3 in-slice entries granted, got %d", len(v.RPC.Entries))
	}
	return v
}

// checkLinkVectors plays the browser holder in Go: everything is derived from
// the secret and the RPC response alone.
func checkLinkVectors(t *testing.T, v linkVectors) {
	t.Helper()
	secret, err := base64.RawURLEncoding.DecodeString(v.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if got := deriveLinkToken(secret); got != v.LinkToken {
		t.Fatalf("link token = %s, want %s", got, v.LinkToken)
	}
	if got := linkTokenHash(v.LinkToken); got != v.TokenHash {
		t.Fatalf("token hash = %s, want %s", got, v.TokenHash)
	}
	r := v.RPC
	salt, _ := unb64(r.SaltEnc)
	kek := deriveLinkKEK(secret, salt)
	if hex.EncodeToString(kek) != v.KEKHex {
		t.Fatal("link KEK does not match the vector")
	}
	wid, _ := unb64(r.WrappedIdentity)
	inonce, _ := unb64(r.IdentityNonce)
	recipient, err := sharing.UnwrapIdentity(wid, inonce, kek, r.MemberID)
	if err != nil {
		t.Fatalf("unwrap identity: %v", err)
	}
	tb, _ := unb64(r.TrustBundle)
	tbn, _ := unb64(r.TrustBundleNonce)
	senderSigPub, err := open(kek, tb, tbn)
	if err != nil {
		t.Fatalf("open trust bundle: %v", err)
	}
	if b64(senderSigPub) != v.SenderSigPub {
		t.Fatal("trust bundle does not carry the sender's signing key")
	}
	epochs := map[int][]byte{}
	for _, k := range r.EpochKeys {
		wrapped, _ := unb64(k.WrappedEpochPrivkey)
		epochs[k.Epoch], err = sharing.UnwrapEpochKeyForMember(recipient.EncPriv.Bytes(), wrapped,
			sharing.EpochKeyAAD{AudienceID: r.AudienceID, Epoch: k.Epoch, MemberID: r.MemberID})
		if err != nil {
			t.Fatalf("unwrap epoch %d: %v", k.Epoch, err)
		}
	}
	if len(r.Entries) != len(v.Entries) {
		t.Fatalf("%d rpc entries, %d expected", len(r.Entries), len(v.Entries))
	}
	for i, e := range r.Entries {
		wrapped, _ := unb64(e.WrappedDEK)
		dek, uerr := sharing.UnwrapDEKFromEpoch(epochs[e.GrantEpoch], wrapped,
			sharing.GrantAAD{EntryID: e.ID, AudienceID: r.AudienceID, Epoch: e.GrantEpoch})
		if uerr != nil {
			t.Fatalf("entry %d: unwrap DEK: %v", i, uerr)
		}
		ct, _ := unb64(e.Ciphertext)
		nonce, _ := unb64(e.Nonce)
		aad := sharing.EntryAAD{EntryID: e.ID, Version: e.Version, AuthorID: e.AuthorID}
		plain, derr := sharing.DecryptEntryPayload(dek, ct, nonce, aad)
		if derr != nil {
			t.Fatalf("entry %d: decrypt: %v", i, derr)
		}
		var got canonicalEntry
		if jerr := json.Unmarshal(plain, &got); jerr != nil {
			t.Fatal(jerr)
		}
		if got != v.Entries[i] {
			t.Fatalf("entry %d = %+v, want %+v", i, got, v.Entries[i])
		}
		sig, _ := unb64(e.AuthorSig)
		if ok, serr := sharing.VerifyEntrySig(ed25519.PublicKey(senderSigPub), aad, ct, sig); serr != nil || !ok {
			t.Fatalf("entry %d: author signature did not verify (ok=%v err=%v)", i, ok, serr)
		}
	}
}
