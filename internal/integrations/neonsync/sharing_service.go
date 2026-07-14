package neonsync

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// ecdhPriv aliases the X25519 private-key type the sharing package returns from
// GenerateEpochKeypair, so signatures here read without leaking crypto/ecdh into
// every call site.
type ecdhPriv = ecdh.PrivateKey

// This file is the operations layer of the E2EE live-sharing feature
// (e2ee-sharing-plan-v2.md). It sits between the pure crypto core (the sharing
// package) and the PostgREST transport (sharing_client.go), and it owns the
// obligations RLS cannot enforce: verify every signature and the epoch chain
// BEFORE wrapping anything, bind the correct AAD on every seal/open, push
// entries before grants, and clean up soft-revoked grants on reconcile.

// identityAccount is the Keychain slot holding the unwrapped identity keypair
// (serialized as base64 privkeys). Populated inside Unlock, cleared by Lock.
const identityAccount = "identity"

// entryVersion is the fixed entry version for v1 (§8: edit correlation via
// version/supersedes is out of scope; every entry is version 1, supersedes null).
const entryVersion = 1

// ErrNotPinned signals a member/admin/author identity whose fingerprint is not
// pin-verified. Trusting such a key would defeat the whole E2EE guarantee (§9),
// so every path that would wrap to or accept from it hard-fails with this.
var ErrNotPinned = errors.New("neonsync: identity fingerprint is not pinned")

// Pins exposes the fingerprint-pin store so the UI can pin a verified
// fingerprint out of band (plan §9) before an AddMember or a shared read.
func (s *Service) Pins() *PinStore {
	return s.pins
}

// provisionIdentity is the identity-provisioning step folded into Unlock — the
// only place the KEK exists. If the user_keys row has no wrapped_identity yet it
// mints a fresh identity, wraps it under the KEK, PATCHes user_keys, upserts the
// public halves into identities, and caches the unwrapped identity in Keychain.
// Otherwise it unwraps the existing identity with the KEK and caches it. Called
// from Unlock with the KEK and the already-fetched (or freshly provisioned) row.
func (s *Service) provisionIdentity(ctx context.Context, base, token, userID, email string, kek []byte, row *userKeysRow) error {
	if row != nil && row.WrappedIdentity != "" && row.IdentityNonce != "" {
		id, err := unwrapIdentityFromRow(kek, userID, row)
		if err != nil {
			return err
		}
		// Best-effort email_hash backfill: re-publish so an already-provisioned
		// identity becomes discoverable by email without re-provisioning. A
		// failure here (the column not yet migrated, a transient write) must
		// NEVER block caching an otherwise-valid identity — that would break
		// sharing for existing users. Ignore it; the next unlock retries.
		_ = s.publishIdentity(ctx, base, token, userID, email, id.Public())
		return s.saveIdentity(ctx, id)
	}

	id, err := sharing.GenerateIdentity()
	if err != nil {
		return err
	}
	ct, nonce, err := sharing.WrapIdentity(id, kek, userID)
	if err != nil {
		return err
	}
	if perr := patchIdentityColumns(ctx, s.http, base, token, b64(ct), b64(nonce)); perr != nil {
		return gerrors.Wrap(perr, "store wrapped identity")
	}
	if perr := s.publishIdentity(ctx, base, token, userID, email, id.Public()); perr != nil {
		return perr
	}
	return s.saveIdentity(ctx, id)
}

// publishIdentity upserts the caller's public identity row, including the email
// discovery hash when an email is known. omitempty on email_hash means a blank
// email never clobbers a previously published hash.
func (s *Service) publishIdentity(ctx context.Context, base, token, userID, email string, pub sharing.PublicIdentity) error {
	row := identityRow{
		UserID:    userID,
		PubEnc:    b64(pub.EncPub),
		PubSig:    b64(pub.SigPub),
		EmailHash: emailHash(email),
	}
	if err := upsertIdentity(ctx, s.http, base, token, row); err != nil {
		return gerrors.Wrap(err, "publish identity")
	}
	return nil
}

func unwrapIdentityFromRow(kek []byte, userID string, row *userKeysRow) (*sharing.Identity, error) {
	ct, err := unb64(row.WrappedIdentity)
	if err != nil {
		return nil, gerrors.Wrap(err, "decode wrapped identity")
	}
	nonce, err := unb64(row.IdentityNonce)
	if err != nil {
		return nil, gerrors.Wrap(err, "decode identity nonce")
	}
	id, err := sharing.UnwrapIdentity(ct, nonce, kek, userID)
	if err != nil {
		return nil, gerrors.Wrap(err, "unwrap identity")
	}
	return id, nil
}

// loadIdentity recovers the cached identity from Keychain. A missing slot means
// sharing operations are locked (the identity is only cached during a session).
func (s *Service) loadIdentity(ctx context.Context) (*sharing.Identity, error) {
	encPrivRaw, err := s.store.Load(ctx, identityAccount+"-enc")
	if err != nil {
		return nil, ErrLocked
	}
	sigPrivRaw, err := s.store.Load(ctx, identityAccount+"-sig")
	if err != nil {
		return nil, ErrLocked
	}
	encPriv, err := unb64(encPrivRaw)
	if err != nil {
		return nil, err
	}
	sigPriv, err := unb64(sigPrivRaw)
	if err != nil {
		return nil, err
	}
	return decodeIdentity(encPriv, sigPriv)
}

func (s *Service) saveIdentity(ctx context.Context, id *sharing.Identity) error {
	if err := s.store.Save(ctx, identityAccount+"-enc", b64(id.EncPriv.Bytes())); err != nil {
		return err
	}
	return s.store.Save(ctx, identityAccount+"-sig", b64(id.SigPriv))
}

// clearIdentity drops the cached identity. Called from Lock.
func (s *Service) clearIdentity(ctx context.Context) {
	_ = s.store.Delete(ctx, identityAccount+"-enc")
	_ = s.store.Delete(ctx, identityAccount+"-sig")
}

// decodeIdentity reconstructs an Identity from its raw private-key bytes.
func decodeIdentity(encPriv, sigPriv []byte) (*sharing.Identity, error) {
	enc, err := ecdh.X25519().NewPrivateKey(encPriv)
	if err != nil {
		return nil, gerrors.Wrap(err, "identity enc key")
	}
	if len(sigPriv) != ed25519.PrivateKeySize {
		return nil, errors.New("identity sig key wrong size")
	}
	return &sharing.Identity{EncPriv: enc, SigPriv: ed25519.PrivateKey(sigPriv)}, nil
}

// publicFromRow decodes an identities row into a PublicIdentity.
func publicFromRow(row *identityRow) (sharing.PublicIdentity, error) {
	encPub, err := unb64(row.PubEnc)
	if err != nil {
		return sharing.PublicIdentity{}, gerrors.Wrap(err, "decode pub_enc")
	}
	sigPub, err := unb64(row.PubSig)
	if err != nil {
		return sharing.PublicIdentity{}, gerrors.Wrap(err, "decode pub_sig")
	}
	if len(sigPub) != ed25519.PublicKeySize {
		return sharing.PublicIdentity{}, errors.New("pub_sig wrong size")
	}
	return sharing.PublicIdentity{EncPub: encPub, SigPub: ed25519.PublicKey(sigPub)}, nil
}

// randomHexID mints a client-side random id for audiences and shares.
func randomHexID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", gerrors.Wrap(err, "random id")
	}
	return hex.EncodeToString(b), nil
}

// sharingSession bundles everything a sharing operation needs: the transport
// coordinates, the caller's own id + cached identity + account DEK. Built once
// per operation so each method is a thin sequence of verified steps.
type sharingSession struct {
	svc    *Service
	base   string
	token  string
	userID string
	id     *sharing.Identity
	dek    []byte
}

func (s *Service) session(ctx context.Context) (*sharingSession, error) {
	base := s.dataURL()
	if base == "" {
		return nil, ErrNotConfigured
	}
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return nil, gerrors.Wrap(err, "auth token")
	}
	dek, err := s.loadDEK(ctx)
	if err != nil {
		return nil, ErrLocked
	}
	id, err := s.loadIdentity(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := ownerFromKeys(ctx, s.http, base, token)
	if err != nil {
		return nil, err
	}
	return &sharingSession{svc: s, base: base, token: token, userID: userID, id: id, dek: dek}, nil
}

// CreateAudience bootstraps a new audience owned by the caller: the audiences
// row, the caller's self-admin member row, epoch 1 (a self-signed announcement),
// and the epoch-1 private key wrapped to the caller. The caller trivially trusts
// their own key, so no pin check is needed here.
func (s *Service) CreateAudience(ctx context.Context) (string, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return "", err
	}
	audienceID, err := randomHexID()
	if err != nil {
		return "", err
	}

	if aerr := insertAudience(ctx, s.http, sess.base, sess.token, audienceRow{
		ID: audienceID, CreatedBy: sess.userID,
	}); aerr != nil {
		return "", gerrors.Wrap(aerr, "create audience")
	}
	if merr := insertMember(ctx, s.http, sess.base, sess.token, audienceMemberRow{
		AudienceID: audienceID, MemberID: sess.userID, Role: "admin",
	}); merr != nil {
		return "", gerrors.Wrap(merr, "bootstrap self admin")
	}

	epochPriv, err := sharing.GenerateEpochKeypair()
	if err != nil {
		return "", err
	}
	// Epoch 1: prev hash "" (§2b). Sign and publish, then wrap the epoch privkey
	// to ourselves so we can read our own future grants.
	if err = s.publishEpoch(ctx, sess, audienceID, 1, "", epochPriv); err != nil {
		return "", err
	}
	if err = s.wrapEpochToMembers(ctx, sess, audienceID, 1, epochPriv.Bytes(),
		[]memberKey{{id: sess.userID, encPub: sess.id.Public().EncPub}}); err != nil {
		return "", err
	}
	// Self-pin so later verification of our own admin signatures succeeds.
	if perr := s.pins.Pin(sess.userID, sharing.Fingerprint(sess.id.Public())); perr != nil {
		return "", perr
	}
	return audienceID, nil
}

// publishEpoch signs an epoch announcement with the caller's admin identity key
// and inserts it (the bump-pointer trigger advances audiences.current_epoch).
func (s *Service) publishEpoch(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	epoch int,
	prevHash string,
	epochPriv *ecdhPriv,
) error {
	ann := sharing.EpochAnnouncement{
		AudienceID: audienceID,
		Epoch:      epoch,
		EpochPub:   epochPriv.PublicKey().Bytes(),
		PrevHash:   prevHash,
	}
	sig, err := sharing.SignAnnouncement(sess.id.SigPriv, ann)
	if err != nil {
		return err
	}
	return insertEpoch(ctx, s.http, sess.base, sess.token, audienceEpochRow{
		AudienceID: audienceID,
		Epoch:      epoch,
		EpochPub:   b64(ann.EpochPub),
		PrevEpoch:  prevHash,
		AdminID:    sess.userID,
		AdminSig:   b64(sig),
	})
}

type memberKey struct {
	id     string
	encPub []byte
}

// wrapEpochToMembers seals an epoch private key to each member's identity pubkey,
// binding (audience_id, epoch, member_id) as AAD, and inserts the rows.
func (s *Service) wrapEpochToMembers(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	epoch int,
	epochPriv []byte,
	members []memberKey,
) error {
	rows := make([]audienceEpochKeyRow, 0, len(members))
	for _, m := range members {
		wrapped, err := sharing.WrapEpochKeyToMember(m.encPub, epochPriv, sharing.EpochKeyAAD{
			AudienceID: audienceID, Epoch: epoch, MemberID: m.id,
		})
		if err != nil {
			return err
		}
		rows = append(rows, audienceEpochKeyRow{
			AudienceID: audienceID, Epoch: epoch, MemberID: m.id,
			WrappedEpochPrivkey: b64(wrapped),
		})
	}
	if err := insertEpochKeys(ctx, s.http, sess.base, sess.token, rows); err != nil {
		return gerrors.Wrap(err, "wrap epoch to members")
	}
	return nil
}

// pinnedIdentity fetches a user's public identity and verifies its fingerprint
// against the pin store. A missing identity or an unpinned/mismatched
// fingerprint is a hard failure (ErrNotPinned) — the crown-jewel trust seam (§9).
func (s *Service) pinnedIdentity(ctx context.Context, sess *sharingSession, userID string) (sharing.PublicIdentity, error) {
	row, err := getIdentity(ctx, s.http, sess.base, sess.token, userID)
	if errors.Is(err, errIdentityNotFound) {
		return sharing.PublicIdentity{}, ErrNotPinned
	}
	if err != nil {
		return sharing.PublicIdentity{}, err
	}
	pub, err := publicFromRow(row)
	if err != nil {
		return sharing.PublicIdentity{}, err
	}
	ok, err := s.pins.Verify(userID, sharing.Fingerprint(pub))
	if err != nil {
		return sharing.PublicIdentity{}, err
	}
	if !ok {
		return sharing.PublicIdentity{}, ErrNotPinned
	}
	return pub, nil
}

// verifiedEpochs fetches the FULL epoch history for an audience, checks the
// high-watermark (truncation detector), and verifies the whole signed chain
// against the pinned admin keys. Any unverifiable epoch is a hard stop for the
// audience (§2b). Returns the announcements in order on success.
func (s *Service) verifiedEpochs(ctx context.Context, sess *sharingSession, audienceID string) ([]sharing.EpochAnnouncement, error) {
	rows, err := getEpochs(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return nil, err
	}
	if err = s.pins.CheckEpochWatermark(audienceID, len(rows)); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}

	anns := make([]sharing.EpochAnnouncement, len(rows))
	sigs := make([][]byte, len(rows))
	adminPubs := make([]ed25519.PublicKey, len(rows))
	for i, r := range rows {
		epochPub, derr := unb64(r.EpochPub)
		if derr != nil {
			return nil, derr
		}
		sig, derr := unb64(r.AdminSig)
		if derr != nil {
			return nil, derr
		}
		adminPub, perr := s.pinnedIdentity(ctx, sess, r.AdminID)
		if perr != nil {
			return nil, gerrors.Wrapf(perr, "epoch %d admin", r.Epoch)
		}
		anns[i] = sharing.EpochAnnouncement{
			AudienceID: r.AudienceID, Epoch: r.Epoch, EpochPub: epochPub, PrevHash: r.PrevEpoch,
		}
		sigs[i] = sig
		adminPubs[i] = adminPub.SigPub
	}
	if err = sharing.VerifyChain(anns, sigs, adminPubs); err != nil {
		return nil, err
	}
	return anns, nil
}

// unwrapEpochKey unwraps the epoch private key wrapped to the caller for a given
// (audience, epoch), binding the (audience, epoch, member) AAD.
func (s *Service) unwrapEpochKey(ctx context.Context, sess *sharingSession, audienceID string, epoch int) ([]byte, error) {
	keys, err := getMyEpochKeys(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		if k.Epoch != epoch || k.MemberID != sess.userID {
			continue
		}
		wire, derr := unb64(k.WrappedEpochPrivkey)
		if derr != nil {
			return nil, derr
		}
		return sharing.UnwrapEpochKeyForMember(sess.id.EncPriv.Bytes(), wire, sharing.EpochKeyAAD{
			AudienceID: audienceID, Epoch: epoch, MemberID: sess.userID,
		})
	}
	return nil, gerrors.Errorf("no epoch key held for audience %s epoch %d", audienceID, epoch)
}

// AddMember adds userID to an audience with the given role, wrapping the current
// epoch key to them. Their identity pubkey MUST be pin-verified first (hard fail
// otherwise, §9). withHistory additionally wraps every prior epoch key to them
// (the explicit history-visible join of §4).
func (s *Service) AddMember(ctx context.Context, audienceID, userID, role string, withHistory bool) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	pub, err := s.pinnedIdentity(ctx, sess, userID)
	if err != nil {
		return err
	}
	verified, err := s.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		return err
	}
	if len(verified) == 0 {
		return errors.New("audience has no epochs")
	}
	if merr := insertMember(ctx, s.http, sess.base, sess.token, audienceMemberRow{
		AudienceID: audienceID, MemberID: userID, Role: role,
	}); merr != nil {
		return gerrors.Wrap(merr, "add member")
	}

	// Which epochs to wrap: current only (join-forward) or all (history-visible).
	targets := verified[len(verified)-1:]
	if withHistory {
		targets = verified
	}
	for _, ann := range targets {
		epochPriv, uerr := s.unwrapEpochKey(ctx, sess, audienceID, ann.Epoch)
		if uerr != nil {
			return uerr
		}
		if werr := s.wrapEpochToMembers(ctx, sess, audienceID, ann.Epoch, epochPriv,
			[]memberKey{{id: userID, encPub: pub.EncPub}}); werr != nil {
			return werr
		}
	}
	return nil
}

// RemoveMember deletes a member and mints a fresh epoch (forward secrecy, §4):
// a new admin-signed announcement chained to the prior epoch, the new epoch key
// wrapped to each REMAINING pinned member, and the share filter re-wrapped to
// the new epoch. The removed member keeps only old-epoch keys, so all future
// entries are dark to them.
func (s *Service) RemoveMember(ctx context.Context, audienceID, userID string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	verified, err := s.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		return err
	}
	if len(verified) == 0 {
		return errors.New("audience has no epochs")
	}

	if derr := deleteMember(ctx, s.http, sess.base, sess.token, audienceID, userID); derr != nil {
		return gerrors.Wrap(derr, "remove member")
	}

	// Remaining members (the roster now excludes the removed user). Every one we
	// wrap the new epoch key to must be pin-verified, same seam as AddMember.
	members, err := getMembers(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return err
	}
	remaining := make([]memberKey, 0, len(members))
	for _, m := range members {
		if m.MemberID == userID {
			continue
		}
		pub, perr := s.pinnedIdentity(ctx, sess, m.MemberID)
		if perr != nil {
			return gerrors.Wrapf(perr, "member %s", m.MemberID)
		}
		remaining = append(remaining, memberKey{id: m.MemberID, encPub: pub.EncPub})
	}

	prev := verified[len(verified)-1]
	prevHash, err := prev.Hash()
	if err != nil {
		return err
	}
	newEpoch := prev.Epoch + 1
	newPriv, err := sharing.GenerateEpochKeypair()
	if err != nil {
		return err
	}
	if err = s.publishEpoch(ctx, sess, audienceID, newEpoch, prevHash, newPriv); err != nil {
		return err
	}
	if err = s.wrapEpochToMembers(ctx, sess, audienceID, newEpoch, newPriv.Bytes(), remaining); err != nil {
		return err
	}
	// Advance the watermark so a later truncation back to the old count is caught.
	if werr := s.pins.CheckEpochWatermark(audienceID, newEpoch); werr != nil {
		return werr
	}
	return s.rewrapFilter(ctx, sess, audienceID, newEpoch, newPriv.PublicKey().Bytes())
}

// rewrapFilter re-encrypts the audience's existing share filter to a new epoch
// key (the re-wrap step of §4a on an epoch bump). No-op if no share exists yet.
func (s *Service) rewrapFilter(ctx context.Context, sess *sharingSession, audienceID string, epoch int, epochPub []byte) error {
	filter, shareID, ok, err := s.currentFilter(ctx, sess, audienceID)
	if err != nil || !ok {
		return err
	}
	return s.writeShare(ctx, sess, audienceID, shareID, epoch, epochPub, filter)
}

// SetShareFilter encrypts a projects/since-days filter to the audience's current
// verified epoch key and upserts the shares row. Creating the first share is
// what lets members' grant inserts pass the integrity-of-membership clause (§5).
func (s *Service) SetShareFilter(ctx context.Context, audienceID string, projects []string, sinceDays int) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	verified, err := s.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		return err
	}
	if len(verified) == 0 {
		return errors.New("audience has no epochs")
	}
	current := verified[len(verified)-1]

	// Reuse an existing share id if one exists so the upsert updates in place.
	_, shareID, ok, err := s.currentFilter(ctx, sess, audienceID)
	if err != nil {
		return err
	}
	if !ok {
		if shareID, err = randomHexID(); err != nil {
			return err
		}
	}
	filter := shareFilter{Projects: projects, SinceDays: sinceDays}
	return s.writeShare(ctx, sess, audienceID, shareID, current.Epoch, current.EpochPub, filter)
}

// writeShare marshals, encrypts (bound to audience+epoch), and upserts a share.
func (s *Service) writeShare(
	ctx context.Context,
	sess *sharingSession,
	audienceID, shareID string,
	epoch int,
	epochPub []byte,
	filter shareFilter,
) error {
	plain, err := filter.marshal()
	if err != nil {
		return err
	}
	ct, err := sharing.WrapFilterToEpoch(epochPub, plain, sharing.FilterAAD{AudienceID: audienceID, Epoch: epoch})
	if err != nil {
		return err
	}
	return upsertShare(ctx, s.http, sess.base, sess.token, shareRow{
		ID: shareID, AudienceID: audienceID, Epoch: epoch,
		FilterCiphertext: b64(ct), CreatedBy: sess.userID,
	})
}

// currentFilter fetches and decrypts the audience's share filter using the epoch
// key it is wrapped to. Returns ok=false when no share row exists yet.
func (s *Service) currentFilter(ctx context.Context, sess *sharingSession, audienceID string) (shareFilter, string, bool, error) {
	shares, err := getShares(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return shareFilter{}, "", false, err
	}
	if len(shares) == 0 {
		return shareFilter{}, "", false, nil
	}
	sh := shares[0]
	epochPriv, err := s.unwrapEpochKey(ctx, sess, audienceID, sh.Epoch)
	if err != nil {
		return shareFilter{}, "", false, err
	}
	ct, err := unb64(sh.FilterCiphertext)
	if err != nil {
		return shareFilter{}, "", false, err
	}
	plain, err := sharing.UnwrapFilterFromEpoch(epochPriv, ct, sharing.FilterAAD{AudienceID: audienceID, Epoch: sh.Epoch})
	if err != nil {
		return shareFilter{}, "", false, err
	}
	filter, err := unmarshalFilter(plain)
	if err != nil {
		return shareFilter{}, "", false, err
	}
	return filter, sh.ID, true, nil
}

// RevokeGrant is the admin §4a fast path: a visibility-plane soft-revoke that
// takes effect immediately on the read predicate. The crypto-plane cleanup
// (deleting the wrapped DEK) happens when the entry's author next reconciles.
func (s *Service) RevokeGrant(ctx context.Context, entryID, audienceID string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	return revokeGrant(ctx, s.http, sess.base, sess.token, entryID, audienceID, sess.userID)
}

// ApproveContribution flips a pending contribution to approved (visibility-only
// admin action, §4). RejectContribution is its mirror.
func (s *Service) ApproveContribution(ctx context.Context, entryID string) error {
	return s.setContributionStatus(ctx, entryID, "approved")
}

func (s *Service) RejectContribution(ctx context.Context, entryID string) error {
	return s.setContributionStatus(ctx, entryID, "rejected")
}

func (s *Service) setContributionStatus(ctx context.Context, entryID, status string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	return patchContributionStatus(ctx, s.http, sess.base, sess.token, entryID, status)
}

// timeToParam formats a time as the RFC3339 string PostgREST/Postgres accept for
// a timestamptz column.
func timeToParam(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// SharedEntry is one decrypted, author-verified entry returned by the shared
// read path — the caller renders it but must NOT merge it into the local log.
type SharedEntry struct {
	AudienceID string          `json:"audience_id"`
	AuthorID   string          `json:"author_id"`
	Activity   models.Activity `json:"activity"`
	Status     string          `json:"status"`
}
