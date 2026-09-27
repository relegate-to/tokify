package neonsync

import (
	"context"
	"errors"
	"maps"
	"slices"
	"sort"
	"time"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// The shared read path. Each poll asks the server which of the caller's
// audiences changed since the last one (audience_changes, sharing_schema.sql
// Section 7) and re-reads only those: a delta when grants or entries changed,
// the whole audience when its epochs, keys, or membership did. Unchanged
// audiences are served from what was already decrypted and verified, so an idle
// poll costs one small request instead of a walk over all shared history.
// A server without Section 7 gets the full walk on every poll, as before.

// sharedReadState is what the read path carries between polls. It holds only
// what the app already renders — decrypted entries and cursors, never keys —
// and is dropped when the signed-in user or the pinned fingerprints change.
type sharedReadState struct {
	userID    string
	trust     string
	audiences map[string]*audienceView
}

// audienceView is one audience's decrypted, author-verified entries (keyed by
// entry id) and the cursors they are current to.
type audienceView struct {
	seq          int64
	structureSeq int64
	maxEpoch     int
	entries      map[string]sharedView
}

type sharedView struct {
	grant grantRow
	entry SharedEntry
}

// readKeys memoizes unwrapped epoch keys and pinned author keys within one
// audience refresh; like the account DEK, neither is held beyond it.
type readKeys struct {
	epochPrivs map[int][]byte
	authorPubs map[string]sharing.PublicIdentity
}

func newReadKeys() *readKeys {
	return &readKeys{epochPrivs: map[int][]byte{}, authorPubs: map[string]sharing.PublicIdentity{}}
}

// ListSharedEntries returns every entry granted to the caller across the
// audiences they belong to, decrypted and author-verified, WITHOUT merging any
// of it into the local log. For each audience it verifies the epoch chain, then
// for each live grant it unwraps the epoch key, unwraps the DEK (GrantAAD-bound),
// verifies the author signature against the PINNED author identity (hard fail if
// unpinned), and decrypts the payload.
func (s *Service) ListSharedEntries(ctx context.Context) ([]SharedEntry, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	return s.listSharedEntries(ctx, sess, time.Now())
}

func (s *Service) listSharedEntries(ctx context.Context, sess *sharingSession, now time.Time) ([]SharedEntry, error) {
	s.sharedMu.Lock()
	defer s.sharedMu.Unlock()

	// Converge trust decisions from the account's other devices before reading:
	// without this a device provisioned in a past session would render teammates
	// as unverified and hard-fail on ErrNotPinned for their shared entries.
	s.pullPins(ctx, sess)
	trust, err := s.pins.trustState()
	if err != nil {
		return nil, err
	}
	if s.shared.userID != sess.userID || s.shared.trust != trust || s.shared.audiences == nil {
		s.shared = sharedReadState{userID: sess.userID, trust: trust, audiences: map[string]*audienceView{}}
	}

	changes, err := getAudienceChanges(ctx, s.http, sess.base, sess.token)
	if isMissingSchema(err) {
		s.shared.audiences = map[string]*audienceView{}
		return s.listSharedEntriesUntracked(ctx, sess, now)
	}
	if err != nil {
		return nil, err
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].AudienceID < changes[j].AudienceID })

	current := make(map[string]bool, len(changes))
	var out []SharedEntry
	for _, ch := range changes {
		view, rerr := s.refreshAudienceView(ctx, sess, ch, s.shared.audiences[ch.AudienceID], now)
		if rerr != nil {
			return nil, gerrors.Wrapf(rerr, "audience %s", ch.AudienceID)
		}
		s.shared.audiences[ch.AudienceID] = view
		current[ch.AudienceID] = true
		out = append(out, view.live(now)...)
	}
	maps.DeleteFunc(s.shared.audiences, func(id string, _ *audienceView) bool { return !current[id] })
	return out, nil
}

// listSharedEntriesUntracked is the read path against a server without change
// tracking: every audience is read in full on every call.
func (s *Service) listSharedEntriesUntracked(ctx context.Context, sess *sharingSession, now time.Time) ([]SharedEntry, error) {
	audiences, err := getAudiences(ctx, s.http, sess.base, sess.token)
	if err != nil {
		return nil, err
	}
	sort.Slice(audiences, func(i, j int) bool { return audiences[i].ID < audiences[j].ID })
	var out []SharedEntry
	for _, aud := range audiences {
		view, rerr := s.readAudienceFull(ctx, sess, aud.ID, now)
		if rerr != nil {
			return nil, gerrors.Wrapf(rerr, "audience %s", aud.ID)
		}
		out = append(out, view.live(now)...)
	}
	return out, nil
}

// refreshAudienceView brings one audience's view up to the server's cursors.
// A structural change (epoch, epoch keys, membership) can change what the
// caller may see or decrypt without touching a grant, and a cursor older than
// the pruned removals would miss deletions, so both re-read the audience.
func (s *Service) refreshAudienceView(
	ctx context.Context,
	sess *sharingSession,
	ch audienceChangeRow,
	view *audienceView,
	now time.Time,
) (*audienceView, error) {
	if view != nil && view.seq == ch.Seq && view.structureSeq == ch.StructureSeq {
		return view, nil
	}
	var (
		next *audienceView
		err  error
	)
	if view == nil || view.structureSeq != ch.StructureSeq || view.seq < ch.RemovalsFloor {
		next, err = s.readAudienceFull(ctx, sess, ch.AudienceID, now)
	} else {
		next, err = s.readAudienceDelta(ctx, sess, ch.AudienceID, view, now)
	}
	if err != nil {
		return nil, err
	}
	next.seq, next.structureSeq = ch.Seq, ch.StructureSeq
	return next, nil
}

// readAudienceFull verifies the audience's epoch chain, then fetches, verifies,
// and decrypts the entry behind every live grant from another author.
func (s *Service) readAudienceFull(ctx context.Context, sess *sharingSession, audienceID string, now time.Time) (*audienceView, error) {
	view := &audienceView{entries: map[string]sharedView{}}
	verified, err := s.verifiedEpochs(ctx, sess, audienceID)
	if err != nil {
		return nil, err
	}
	if len(verified) == 0 {
		return view, nil
	}
	view.maxEpoch = verified[len(verified)-1].Epoch

	grants, err := getGrantsForAudience(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return nil, err
	}
	// Only grants that are not my own authored entries are "shared to me"; a
	// grant I authored points at my own entry, already in my local log. Filter to
	// other authors, live, and within the time window.
	live := make(map[string]grantRow)
	var wantIDs []string
	for _, g := range grants {
		if g.AuthorID == sess.userID || !grantLive(g, now) {
			continue
		}
		wantIDs = append(wantIDs, g.EntryID)
		live[g.EntryID] = g
	}
	if len(wantIDs) == 0 {
		return view, nil
	}

	rows, err := getEntriesByIDs(ctx, s.http, sess.base, sess.token, wantIDs)
	if err != nil {
		return nil, err
	}
	keys := newReadKeys()
	for i := range rows {
		g, ok := live[rows[i].ID]
		if !ok {
			continue
		}
		if aerr := s.applySharedRow(ctx, sess, audienceID, view, g, &rows[i], keys); aerr != nil {
			return nil, aerr
		}
	}
	return view, nil
}

// readAudienceDelta applies the grants removed and the grants (or entries)
// changed since the view's cursor. The view passed in is left untouched, so a
// failed refresh keeps serving the last-good entries.
func (s *Service) readAudienceDelta(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	view *audienceView,
	now time.Time,
) (*audienceView, error) {
	removals, err := getGrantRemovals(ctx, s.http, sess.base, sess.token, audienceID, view.seq)
	if err != nil {
		return nil, err
	}
	rows, err := getAudienceDelta(ctx, s.http, sess.base, sess.token, audienceID, view.seq)
	if err != nil {
		return nil, err
	}
	// A grant on an epoch this view never verified means the structure moved
	// after the cursors were read; re-verify from scratch rather than trust it.
	if slices.ContainsFunc(rows, func(r deltaRow) bool { return r.Epoch > view.maxEpoch }) {
		return s.readAudienceFull(ctx, sess, audienceID, now)
	}

	next := &audienceView{maxEpoch: view.maxEpoch, entries: maps.Clone(view.entries)}
	// Removals first: every delta row is a grant that exists now, so it wins
	// over any earlier removal of the same entry (a delete-and-reinsert re-grant).
	for _, rm := range removals {
		delete(next.entries, rm.EntryID)
	}
	keys := newReadKeys()
	for _, r := range rows {
		if aerr := s.applySharedRow(ctx, sess, audienceID, next, r.grantRow, r.Entry, keys); aerr != nil {
			return nil, aerr
		}
	}
	return next, nil
}

// applySharedRow sets one grant's entry in the view, or removes it when the
// caller can no longer read it.
func (s *Service) applySharedRow(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	view *audienceView,
	g grantRow,
	row *sharedEntryRow,
	keys *readKeys,
) error {
	if row == nil || row.Deleted || g.Revoked || g.AuthorID == sess.userID {
		delete(view.entries, g.EntryID)
		return nil
	}
	act, err := s.decryptSharedEntry(ctx, sess, audienceID, g, *row, keys.epochPrivs, keys.authorPubs)
	if err != nil {
		// A single undecryptable/unverifiable row is skipped, not fatal — but an
		// unpinned author is a hard fail surfaced to the caller.
		if errors.Is(err, ErrNotPinned) {
			return err
		}
		delete(view.entries, g.EntryID)
		return nil
	}
	view.entries[g.EntryID] = sharedView{
		grant: g,
		entry: SharedEntry{AudienceID: audienceID, AuthorID: row.UserID, Activity: act, Status: row.ContributionStatus},
	}
	return nil
}

// live returns the view's entries whose grant is live at now, in entry id order
// so repeated polls produce identical results.
func (v *audienceView) live(now time.Time) []SharedEntry {
	out := make([]SharedEntry, 0, len(v.entries))
	for _, id := range slices.Sorted(maps.Keys(v.entries)) {
		if sv := v.entries[id]; grantLive(sv.grant, now) {
			out = append(out, sv.entry)
		}
	}
	return out
}
