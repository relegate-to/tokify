package neonsync

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// TestLinkTokenDerivation locks the frozen wire contract for the link secret:
// both halves derive deterministically from S, differ across secrets, and the
// stored token hash matches the RPC's hex(sha256(token)) formula.
func TestLinkTokenDerivation(t *testing.T) {
	s1 := []byte("0123456789abcdef")
	s2 := []byte("fedcba9876543210")

	if tok1, tok2 := deriveLinkToken(s1), deriveLinkToken(s1); tok1 != tok2 {
		t.Fatal("link token derivation is not deterministic")
	}
	if deriveLinkToken(s1) == deriveLinkToken(s2) {
		t.Fatal("distinct secrets produced the same link token")
	}

	// token_hash equals the SQL RPC's encode(sha256(convert_to(token,'UTF8')),'hex').
	tok := deriveLinkToken(s1)
	sum := sha256.Sum256([]byte(tok))
	if linkTokenHash(tok) != hex.EncodeToString(sum[:]) {
		t.Fatal("linkTokenHash does not match hex(sha256(token))")
	}

	// The KEK is salt-dependent and stable for a (secret, salt) pair.
	salt, _ := GenerateSalt()
	if kek1, kek2 := deriveLinkKEK(s1, salt), deriveLinkKEK(s1, salt); string(kek1) != string(kek2) {
		t.Fatal("link KEK derivation is not deterministic")
	}
	salt2, _ := GenerateSalt()
	if string(deriveLinkKEK(s1, salt)) == string(deriveLinkKEK(s1, salt2)) {
		t.Fatal("link KEK did not depend on the salt")
	}
	// Visibility and readability halves are domain-separated: the token bytes
	// must not equal the readability secret.
	if deriveLinkToken(s1) == hex.EncodeToString(hkdfExpand(s1, linkReadabilityInfo, keyLen)) {
		t.Fatal("visibility and readability halves are not domain-separated")
	}
}

// TestCreateLinkShareRecipientCanRead drives provisionLinkRecipient end to end
// against the fake server, then plays the accountless recipient: from nothing
// but the URL-fragment secret and the (would-be RPC) ciphertext, it derives the
// KEK, unwraps the synthetic identity, unwraps the epoch key and DEK, decrypts
// the entry, and verifies the author signature via the trust bundle. This is
// the whole readability plane of the link, proven without a browser viewer.
//
//nolint:gocyclo // end-to-end recipient-decrypt simulation is intentionally one long linear scenario
func TestCreateLinkShareRecipientCanRead(t *testing.T) {
	fake := &fakePostgREST{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	svc := newFlowService(t, srv)
	ctx := context.Background()

	// Sender identity + DEK + session (mirrors the CreateAudience flow test).
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

	// Bootstrap the link's dedicated audience: creator self-admin, epoch 1
	// wrapped to self, and a matching share filter (§3).
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
	if err = svc.writeShare(ctx, sess, audienceID, "share-1", 1, epochPriv.PublicKey().Bytes(),
		shareFilter{Projects: []string{"tokify"}}); err != nil {
		t.Fatal(err)
	}

	// One in-scope completed entry.
	start := time.Date(2026, 7, 13, 9, 0, 0, 0, time.Local)
	end := start.Add(90 * time.Minute)
	act := models.Activity{Project: "tokify", Description: "contract hours", StartTime: start, EndTime: &end}
	entryID := EntryID(dek, canonicalize(act))
	localByID := map[string]models.Activity{entryID: act}

	ls, err := svc.provisionLinkRecipient(ctx, sess, audienceID, localByID, 24*time.Hour)
	if err != nil {
		t.Fatalf("provisionLinkRecipient: %v", err)
	}
	if ls.AudienceID != audienceID || ls.Secret == "" {
		t.Fatalf("unexpected link share result: %+v", ls)
	}

	// Server-side invariants: exactly one link_shares row, one grant, one pushed
	// entry, and the synthetic member is NOT in audience_members (§3).
	if len(fake.linkShares) != 1 {
		t.Fatalf("want 1 link_shares row, got %d", len(fake.linkShares))
	}
	link := fake.linkShares[0]
	if link.ValidUntil == nil {
		t.Fatal("bounded validFor should set valid_until")
	}
	for _, m := range fake.members {
		if m.MemberID == link.MemberID {
			t.Fatal("synthetic member must never be inserted into audience_members")
		}
	}
	if len(fake.grants) != 1 {
		t.Fatalf("want 1 grant, got %d", len(fake.grants))
	}
	if got, want := fake.operations[len(fake.operations)-1], "link-share"; got != want {
		t.Fatalf("last provisioning write = %q, want %q (operations: %v)", got, want, fake.operations)
	}

	// ---- Recipient path: everything below uses only the fragment secret. ----
	secret, err := base64.RawURLEncoding.DecodeString(ls.Secret)
	if err != nil {
		t.Fatal(err)
	}

	// The token the recipient would present must hash to the stored token_hash.
	if linkTokenHash(deriveLinkToken(secret)) != link.TokenHash {
		t.Fatal("recipient-derived token does not match stored token_hash")
	}

	salt, _ := unb64(link.SaltEnc)
	kek := deriveLinkKEK(secret, salt)

	// Unwrap the synthetic identity under the link KEK.
	wid, _ := unb64(link.WrappedIdentity)
	inonce, _ := unb64(link.IdentityNonce)
	recipient, err := sharing.UnwrapIdentity(wid, inonce, kek, link.MemberID)
	if err != nil {
		t.Fatalf("unwrap synthetic identity: %v", err)
	}

	// Trust bundle -> the sender's signing pubkey (author-sig verification, §7).
	tb, _ := unb64(link.TrustBundle)
	tbn, _ := unb64(link.TrustBundleNonce)
	senderSigPub, err := open(kek, tb, tbn)
	if err != nil {
		t.Fatalf("open trust bundle: %v", err)
	}

	// Unwrap the epoch key wrapped to the synthetic member.
	var wrappedEpoch []byte
	for _, k := range fake.epochKeys {
		if k.MemberID == link.MemberID && k.Epoch == 1 {
			wrappedEpoch, _ = unb64(k.WrappedEpochPrivkey)
		}
	}
	if wrappedEpoch == nil {
		t.Fatal("no epoch key wrapped to the synthetic member")
	}
	epochKey, err := sharing.UnwrapEpochKeyForMember(recipient.EncPriv.Bytes(), wrappedEpoch,
		sharing.EpochKeyAAD{AudienceID: audienceID, Epoch: 1, MemberID: link.MemberID})
	if err != nil {
		t.Fatalf("unwrap epoch key: %v", err)
	}

	// Unwrap the DEK from the grant, then decrypt the entry payload.
	g := fake.grants[0]
	wrappedDEK, _ := unb64(g.WrappedDEK)
	grantAAD := sharing.GrantAAD{EntryID: g.EntryID, AudienceID: audienceID, Epoch: 1}
	entryDEK, err := sharing.UnwrapDEKFromEpoch(epochKey, wrappedDEK, grantAAD)
	if err != nil {
		t.Fatalf("unwrap DEK: %v", err)
	}

	var entry sharedEntryRow
	for _, e := range fake.entries {
		if e.ID == g.EntryID {
			entry = e
		}
	}
	if entry.ID == "" {
		t.Fatal("granted entry was not pushed")
	}
	ct, _ := unb64(entry.Ciphertext)
	nonce, _ := unb64(entry.Nonce)
	entryAAD := sharing.EntryAAD{EntryID: entry.ID, Version: entry.Version, AuthorID: entry.UserID}
	plain, err := sharing.DecryptEntryPayload(entryDEK, ct, nonce, entryAAD)
	if err != nil {
		t.Fatalf("decrypt entry payload: %v", err)
	}
	got, err := activityFromCanonical(plain)
	if err != nil {
		t.Fatal(err)
	}
	if got.Project != act.Project || got.Description != act.Description {
		t.Fatalf("decrypted activity mismatch: got %+v want %+v", got, act)
	}

	// The author signature verifies against the trust-bundle signing key.
	sig, _ := unb64(entry.AuthorSig)
	ok, err := sharing.VerifyEntrySig(ed25519.PublicKey(senderSigPub), entryAAD, ct, sig)
	if err != nil || !ok {
		t.Fatalf("author signature did not verify via trust bundle (ok=%v err=%v)", ok, err)
	}

	// A wrong secret must not open the link (KEK is the whole readability gate).
	wrongKEK := deriveLinkKEK([]byte("wrong-secret-1234"), salt)
	if _, uerr := sharing.UnwrapIdentity(wid, inonce, wrongKEK, link.MemberID); uerr == nil {
		t.Fatal("a wrong secret unexpectedly unwrapped the synthetic identity")
	}
}
