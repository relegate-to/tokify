package neonsync

import (
	"context"
	"errors"
	"time"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// This file holds the write/read data paths that ride on top of the sharing
// operations: the v2 entry push (AAD-bound, author-signed), the shared read path
// (list-granted -> unwrap -> verify author sig -> decrypt), and reconcile-on-
// write, which runs inside SyncNow AFTER the push so entries exist before grants.

// pushSharedEntries pushes every completed local entry in its v2 form: the
// payload sealed under the derived DEK, bound to EntryAAD{entryID, version 1,
// authorID}, and author-signed. Entries are keyed by content-hash id so the
// upsert dedupes. This MUST run before any grant insert (the grants FK to
// entries), which reconcile-on-write relies on by running after this.
func (s *Service) pushSharedEntries(ctx context.Context, sess *sharingSession, localByID map[string]models.Activity) error {
	rows := make([]sharedEntryRow, 0, len(localByID))
	for id, act := range localByID {
		row, err := s.encodeSharedEntry(sess, id, act)
		if err != nil {
			return err
		}
		rows = append(rows, row)
	}
	if err := upsertSharedEntries(ctx, s.http, sess.base, sess.token, rows); err != nil {
		return gerrors.Wrap(err, "push shared entries")
	}
	return nil
}

// encodeSharedEntry builds a v2 entry row for one activity: derive the DEK from
// the account DEK + entry id, encrypt the canonical payload with EntryAAD, and
// author-sign the ciphertext.
func (s *Service) encodeSharedEntry(sess *sharingSession, id string, act models.Activity) (sharedEntryRow, error) {
	dek, err := sharing.DeriveEntryDEK(sess.dek, id)
	if err != nil {
		return sharedEntryRow{}, err
	}
	aad := sharing.EntryAAD{EntryID: id, Version: entryVersion, AuthorID: sess.userID}
	ct, nonce, err := sharing.EncryptEntryPayload(dek, canonicalize(act), aad)
	if err != nil {
		return sharedEntryRow{}, err
	}
	sig, err := sharing.SignEntry(sess.id.SigPriv, aad, ct)
	if err != nil {
		return sharedEntryRow{}, err
	}
	return sharedEntryRow{
		ID:         id,
		UserID:     sess.userID,
		Ciphertext: b64(ct),
		Nonce:      b64(nonce),
		Version:    entryVersion,
		AuthorSig:  b64(sig),
		// contribution_status is left to the server DEFAULT ('approved') for the
		// owner's own entries; a non-creator contribution is set to 'pending'
		// explicitly at that call site.
	}, nil
}

// reconcileAudiences runs the reconcile-on-write pass for every audience the
// caller is a member of (plan §4). For each audience it verifies the full epoch
// chain and watermark (a hard stop skips the audience, never wraps to an
// unverified epoch), unwraps the filter, evaluates it over local completed
// entries, inserts missing grants, and deletes grants for entries that no longer
// match / no longer exist / were admin-soft-revoked. Errors on one audience are
// collected and do not abort the others. Runs after the entry push.
func (s *Service) reconcileAudiences(
	ctx context.Context,
	sess *sharingSession,
	localByID map[string]models.Activity,
	now time.Time,
) []error {
	audiences, err := getAudiences(ctx, s.http, sess.base, sess.token)
	if err != nil {
		return []error{gerrors.Wrap(err, "list audiences")}
	}
	var errs []error
	for _, aud := range audiences {
		if rerr := s.reconcileAudience(ctx, sess, aud.ID, localByID, now); rerr != nil {
			errs = append(errs, gerrors.Wrapf(rerr, "audience %s", aud.ID))
		}
	}
	return errs
}

func (s *Service) reconcileAudience(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	localByID map[string]models.Activity,
	now time.Time,
) error {
	// Verify chain + watermark first. An unverifiable epoch is a hard stop (§2b):
	// return the error so this audience is skipped, never wrapped to.
	verified, err := s.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		return err
	}
	if len(verified) == 0 {
		return nil // nothing to wrap to yet
	}
	current := verified[len(verified)-1]

	filter, _, ok, err := s.currentFilter(ctx, sess, audienceID)
	if err != nil {
		return err
	}
	if !ok {
		return nil // no share/intent; nothing to reconcile
	}

	// Existing grants I authored for this audience, indexed by entry id.
	mine, err := getMyGrantsForAudience(ctx, s.http, sess.base, sess.token, audienceID, sess.userID)
	if err != nil {
		return err
	}
	existing := make(map[string]grantRow, len(mine))
	for _, g := range mine {
		existing[g.EntryID] = g
	}

	// Desired set: my local completed entries that match the filter.
	desired := make(map[string]models.Activity)
	for id, act := range localByID {
		if filter.matches(act, now) {
			desired[id] = act
		}
	}

	if err = s.insertMissingGrants(ctx, sess, audienceID, current, filter, existing, desired); err != nil {
		return err
	}
	return s.cleanupStaleGrants(ctx, sess, audienceID, existing, desired)
}

// insertMissingGrants wraps + signs a grant for each desired entry that has no
// live grant on the current epoch yet. A grant on a stale epoch or a
// soft-revoked one is deleted first and re-inserted fresh on the current epoch —
// the grants_guard_update trigger forbids mutating epoch/wrapped_dek/author_sig,
// so delete-and-reinsert is the only permitted re-grant path. This also performs
// the crypto-plane widening for filter changes.
func (s *Service) insertMissingGrants(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	current sharing.EpochAnnouncement,
	filter shareFilter,
	existing map[string]grantRow,
	desired map[string]models.Activity,
) error {
	rows := make([]grantRow, 0)
	for id, act := range desired {
		if g, ok := existing[id]; ok {
			if g.Epoch == current.Epoch && !g.Revoked {
				continue // already granted on the current epoch and live
			}
			if err := deleteGrant(ctx, s.http, sess.base, sess.token, id, audienceID); err != nil {
				return gerrors.Wrapf(err, "delete stale grant %s before re-grant", id)
			}
		}
		dek, err := sharing.DeriveEntryDEK(sess.dek, id)
		if err != nil {
			return err
		}
		grantAAD := sharing.GrantAAD{EntryID: id, AudienceID: audienceID, Epoch: current.Epoch}
		wrapped, err := sharing.WrapDEKToEpoch(current.EpochPub, dek, grantAAD)
		if err != nil {
			return err
		}
		sig, err := sharing.SignGrant(sess.id.SigPriv, grantAAD, wrapped)
		if err != nil {
			return err
		}
		row := grantRow{
			EntryID: id, AudienceID: audienceID, Epoch: current.Epoch,
			AuthorID: sess.userID, WrappedDEK: b64(wrapped), AuthorSig: b64(sig),
			ValidFrom: timeToParam(act.StartTime),
		}
		if until := filter.validUntil(act); until != nil {
			p := timeToParam(*until)
			row.ValidUntil = &p
		}
		rows = append(rows, row)
	}
	if err := insertGrants(ctx, s.http, sess.base, sess.token, rows); err != nil {
		return gerrors.Wrap(err, "insert grants")
	}
	return nil
}

// cleanupStaleGrants deletes the crypto-plane grant for any of my entries that no
// longer belongs in the slice: it no longer matches the filter or its entry no
// longer exists locally (§4a crypto cleanup). Desired entries are entirely
// insertMissingGrants' job — including soft-revoked ones it re-granted, which
// must not be deleted again here.
func (s *Service) cleanupStaleGrants(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	existing map[string]grantRow,
	desired map[string]models.Activity,
) error {
	for id := range existing {
		if _, wanted := desired[id]; wanted {
			continue
		}
		// Not wanted anymore: delete the wrapped DEK.
		if err := deleteGrant(ctx, s.http, sess.base, sess.token, id, audienceID); err != nil {
			return gerrors.Wrapf(err, "delete stale grant %s", id)
		}
	}
	return nil
}

// ListSharedEntries is the shared read path: it returns every entry granted to
// the caller across the audiences they belong to, decrypted and author-verified,
// WITHOUT merging any of it into the local log. For each audience it verifies the
// epoch chain, then for each live grant it unwraps the epoch key, unwraps the
// DEK (GrantAAD-bound), verifies the author signature against the PINNED author
// identity (hard fail if unpinned), and decrypts the payload.
func (s *Service) ListSharedEntries(ctx context.Context) ([]SharedEntry, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	audiences, err := getAudiences(ctx, s.http, sess.base, sess.token)
	if err != nil {
		return nil, err
	}

	var out []SharedEntry
	for _, aud := range audiences {
		entries, aerr := s.readAudienceEntries(ctx, sess, aud.ID)
		if aerr != nil {
			return nil, gerrors.Wrapf(aerr, "audience %s", aud.ID)
		}
		out = append(out, entries...)
	}
	return out, nil
}

func (s *Service) readAudienceEntries(ctx context.Context, sess *sharingSession, audienceID string) ([]SharedEntry, error) {
	verified, err := s.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		return nil, err
	}
	if len(verified) == 0 {
		return nil, nil
	}

	grants, err := getGrantsForAudience(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return nil, err
	}

	// Only grants that are not my own authored entries are "shared to me"; a
	// grant I authored points at my own entry, already in my local log. Filter to
	// other authors, live, and within the time window.
	now := time.Now()
	epochPrivs := make(map[int][]byte)
	authorPubs := make(map[string]sharing.PublicIdentity)
	var wantIDs []string
	live := make(map[string]grantRow)
	for _, g := range grants {
		if g.AuthorID == sess.userID || g.Revoked {
			continue
		}
		if !grantLive(g, now) {
			continue
		}
		wantIDs = append(wantIDs, g.EntryID)
		live[g.EntryID] = g
	}
	if len(wantIDs) == 0 {
		return nil, nil
	}

	rows, err := getEntriesByIDs(ctx, s.http, sess.base, sess.token, wantIDs)
	if err != nil {
		return nil, err
	}

	var out []SharedEntry
	for _, row := range rows {
		if row.Deleted {
			continue
		}
		g := live[row.ID]
		act, aerr := s.decryptSharedEntry(ctx, sess, audienceID, g, row, epochPrivs, authorPubs)
		if aerr != nil {
			// A single undecryptable/unverifiable row is skipped, not fatal — but an
			// unpinned author is a hard fail surfaced to the caller.
			if errors.Is(aerr, ErrNotPinned) {
				return nil, aerr
			}
			continue
		}
		out = append(out, SharedEntry{
			AudienceID: audienceID, AuthorID: row.UserID, Activity: act, Status: row.ContributionStatus,
		})
	}
	return out, nil
}

// decryptSharedEntry performs the per-entry read: unwrap the epoch key (cached
// per epoch), unwrap the DEK with GrantAAD, verify the author signature against
// the pinned author identity (hard fail if unpinned), then decrypt the payload.
func (s *Service) decryptSharedEntry(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	g grantRow,
	row sharedEntryRow,
	epochPrivs map[int][]byte,
	authorPubs map[string]sharing.PublicIdentity,
) (models.Activity, error) {
	epochPriv, ok := epochPrivs[g.Epoch]
	if !ok {
		priv, err := s.unwrapEpochKey(ctx, sess, audienceID, g.Epoch)
		if err != nil {
			return models.Activity{}, err
		}
		epochPriv = priv
		epochPrivs[g.Epoch] = priv
	}

	grantAAD := sharing.GrantAAD{EntryID: row.ID, AudienceID: audienceID, Epoch: g.Epoch}
	wrapped, err := unb64(g.WrappedDEK)
	if err != nil {
		return models.Activity{}, err
	}
	dek, err := sharing.UnwrapDEKFromEpoch(epochPriv, wrapped, grantAAD)
	if err != nil {
		return models.Activity{}, err
	}

	authorPub, ok := authorPubs[row.UserID]
	if !ok {
		pub, perr := s.pinnedIdentity(ctx, sess, row.UserID)
		if perr != nil {
			return models.Activity{}, perr // ErrNotPinned bubbles up as a hard fail
		}
		authorPub = pub
		authorPubs[row.UserID] = pub
	}

	ct, err := unb64(row.Ciphertext)
	if err != nil {
		return models.Activity{}, err
	}
	nonce, err := unb64(row.Nonce)
	if err != nil {
		return models.Activity{}, err
	}
	sig, err := unb64(row.AuthorSig)
	if err != nil {
		return models.Activity{}, err
	}
	entryAAD := sharing.EntryAAD{EntryID: row.ID, Version: row.Version, AuthorID: row.UserID}
	sigOK, err := sharing.VerifyEntrySig(authorPub.SigPub, entryAAD, ct, sig)
	if err != nil {
		return models.Activity{}, err
	}
	if !sigOK {
		return models.Activity{}, errors.New("shared entry author signature invalid")
	}
	plain, err := sharing.DecryptEntryPayload(dek, ct, nonce, entryAAD)
	if err != nil {
		return models.Activity{}, err
	}
	return activityFromCanonical(plain)
}

// grantLive mirrors the RLS live-grant window check for the read path.
func grantLive(g grantRow, now time.Time) bool {
	if g.Revoked {
		return false
	}
	if g.ValidUntil != nil {
		until, err := time.Parse(time.RFC3339, *g.ValidUntil)
		if err == nil && !now.Before(until) {
			return false
		}
	}
	return true
}
