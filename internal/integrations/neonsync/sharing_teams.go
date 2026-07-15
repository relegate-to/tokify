package neonsync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// ErrKeyChanged signals that a member's published identity fingerprint differs
// from the one previously pinned for them — the key-swap the pin exists to catch
// (plan §9). The Teams UI surfaces this as a security warning ("their security
// key changed") and refuses the add rather than silently trusting the new key.
var ErrKeyChanged = errors.New("neonsync: identity fingerprint changed since it was pinned")

// This file is the read side of the audience/membership graph for the Teams UI.
// CreateAudience/AddMember/RemoveMember (sharing_service.go) mutate a team; these
// list what exists so the UI can render it. A "team" here is any audience that is
// NOT a capability link's dedicated audience — link audiences are an
// implementation detail of SharingCreateLink and never surface as teams.

// TeamInfo summarizes one audience the caller belongs to: its id, the caller's
// role in it, the member count, and the current epoch. The human name is
// client-side metadata (teams.json) joined by the app layer, not stored here —
// the server is deliberately blind to team names.
type TeamInfo struct {
	ID           string
	Role         string
	MemberCount  int
	CurrentEpoch int
	// Pending is true when the caller has been invited to this audience but has
	// not accepted yet (their own membership row is status='invited'). While
	// pending they see the invitation but none of the team's shared data; Role is
	// the role they will hold once they accept. MemberCount is not meaningful while
	// pending (RLS shows an invitee only their own row).
	Pending bool
	// InvitedBy is the published display name of the audience creator, filled only
	// when Pending, so the invitation can read "X invited you". Empty when the
	// inviter has published no name.
	InvitedBy string
	// SharedName is the creator's team name, decrypted from audience_names (sealed
	// to the epoch key, invisible to the server). Empty when none is published or
	// it cannot be decrypted; the app layer prefers a device-local name over it.
	// Only populated for active members — a pending invitee cannot read it yet.
	SharedName string
}

// TeamMember is one row of an audience's roster plus whether the caller has
// pin-verified that member's identity fingerprint. Unpinned members are still
// returned (TOFU): the UI shows them so it can offer to pin, and a later key
// change trips the watermark rather than blocking the invite up front.
type TeamMember struct {
	UserID string
	Role   string
	Pinned bool
	// DisplayName is the member's self-published name (identities.display_name),
	// empty if they have published none — the roster falls back to a short id then.
	DisplayName string
	// Status is 'invited' (invited, not yet accepted) or 'active' (accepted), so
	// the roster can flag a pending invite distinctly from a joined member.
	Status string
}

// ListAudiences returns the caller's team audiences — every audience they are a
// member of, excluding the dedicated audiences behind their own capability
// links (those are scoped to the caller by RLS on link_shares, so subtracting
// them here is exact).
func (s *Service) ListAudiences(ctx context.Context) ([]TeamInfo, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	auds, err := getAudiences(ctx, s.http, sess.base, sess.token)
	if err != nil {
		return nil, gerrors.Wrap(err, "list audiences")
	}
	links, err := getLinkShares(ctx, s.http, sess.base, sess.token)
	if err != nil {
		return nil, gerrors.Wrap(err, "list link audiences")
	}
	linkAud := make(map[string]struct{}, len(links))
	for _, l := range links {
		linkAud[l.AudienceID] = struct{}{}
	}

	out := make([]TeamInfo, 0, len(auds))
	for _, aud := range auds {
		if _, isLink := linkAud[aud.ID]; isLink {
			continue
		}
		members, merr := getMembers(ctx, s.http, sess.base, sess.token, aud.ID)
		if merr != nil {
			return nil, gerrors.Wrapf(merr, "members of %s", aud.ID)
		}
		role, status := "", ""
		for _, m := range members {
			if m.MemberID == sess.userID {
				role, status = m.Role, m.Status
				break
			}
		}
		pending := status == "invited"
		invitedBy := ""
		sharedName := ""
		if pending {
			// The invitee can read identities (public), so surface the inviter's
			// name for the invitation. A missing/nameless identity is not an error.
			if idRow, ierr := getIdentity(ctx, s.http, sess.base, sess.token, aud.CreatedBy); ierr == nil {
				invitedBy = idRow.DisplayName
			}
		} else {
			// Active members decrypt the shared team name; best-effort, a failure
			// just leaves it empty and the app falls back to a local name.
			sharedName, _ = s.teamName(ctx, sess, aud.ID)
		}
		out = append(out, TeamInfo{
			ID:           aud.ID,
			Role:         role,
			MemberCount:  len(members),
			CurrentEpoch: aud.CurrentEpoch,
			Pending:      pending,
			InvitedBy:    invitedBy,
			SharedName:   sharedName,
		})
	}
	return out, nil
}

// ShareView is a team's current share: which projects its members can see and
// how far back (SinceDays 0 means "no lower bound" — the whole history of those
// projects). HasShare is false when the team has no share row yet, in which case
// members see nothing.
type ShareView struct {
	Projects  []string
	SinceDays int
	HasShare  bool
}

// TeamShare returns the decrypted share filter for one audience — what the team
// currently sees. The filter is unwrapped with the epoch key it is sealed to; a
// team with no share yet returns HasShare=false and an empty slice.
func (s *Service) TeamShare(ctx context.Context, audienceID string) (ShareView, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return ShareView{}, err
	}
	filter, _, ok, err := s.currentFilter(ctx, sess, audienceID)
	if err != nil {
		return ShareView{}, err
	}
	if !ok {
		return ShareView{Projects: []string{}}, nil
	}
	projects := filter.Projects
	if projects == nil {
		projects = []string{}
	}
	return ShareView{Projects: projects, SinceDays: filter.SinceDays, HasShare: true}, nil
}

// AddMemberTOFU pins a member's identity on first sight (trust-on-first-use) and
// adds them to the audience. It fetches the member's published identity and:
//   - if unpinned, records the fingerprint (TOFU) and proceeds;
//   - if already pinned to the same fingerprint, proceeds;
//   - if pinned to a different fingerprint, returns ErrKeyChanged and adds nobody.
//
// The returned fingerprint is the pinned value, for display or audit. withHistory
// wraps prior epoch keys to the new member (see AddMember); team invites pass it
// so a joiner can decrypt the team's current shared slice even mid-epoch.
func (s *Service) AddMemberTOFU(ctx context.Context, audienceID, userID, role string, withHistory bool) (string, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return "", err
	}
	row, err := getIdentity(ctx, s.http, sess.base, sess.token, userID)
	if err != nil {
		return "", gerrors.Wrap(err, "fetch identity")
	}
	pub, err := publicFromRow(row)
	if err != nil {
		return "", err
	}
	fp := sharing.Fingerprint(pub)
	existing, pinned, err := s.pins.Fingerprint(userID)
	if err != nil {
		return "", err
	}
	if pinned {
		if existing != fp {
			return "", ErrKeyChanged
		}
	} else if perr := s.pins.Pin(userID, fp); perr != nil {
		return "", perr
	}
	if aerr := s.AddMember(ctx, audienceID, userID, role, withHistory); aerr != nil {
		return "", aerr
	}
	return fp, nil
}

// ErrEmailNotFound signals that no published identity matches an email — the
// person has not enabled sharing, or is not a Tokify user. The UI can fall back
// to a capability link (sharing_link.go) for such a recipient.
var ErrEmailNotFound = errors.New("neonsync: no user found for that email")

// emailHash is the discovery handle for an email: hex SHA-256 of the normalized
// (trimmed, lowercased) address. Empty in, empty out — a blank email publishes
// no hash rather than a hash of "". Publisher and inviter derive it identically
// from the address alone (no salt), which is what makes lookup work and also what
// bounds its privacy (see the identities note in sharing_schema.sql).
func emailHash(email string) string {
	e := strings.ToLower(strings.TrimSpace(email))
	if e == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(e))
	return hex.EncodeToString(sum[:])
}

// ResolveEmail looks up the user id behind an email via its discovery hash.
// Returns ErrEmailNotFound when nobody has published that email.
func (s *Service) ResolveEmail(ctx context.Context, email string) (string, error) {
	h := emailHash(email)
	if h == "" {
		return "", errors.New("email is empty")
	}
	sess, err := s.session(ctx)
	if err != nil {
		return "", err
	}
	rows, err := getIdentitiesByEmailHash(ctx, s.http, sess.base, sess.token, h)
	if err != nil {
		return "", gerrors.Wrap(err, "resolve email")
	}
	if len(rows) == 0 {
		return "", ErrEmailNotFound
	}
	return rows[0].UserID, nil
}

// InviteByEmail resolves an email to its user and adds them to the audience with
// TOFU pinning (see AddMemberTOFU). It returns the added user's id. ErrEmailNotFound
// means no such Tokify user; ErrKeyChanged means their published key no longer
// matches a fingerprint pinned earlier.
func (s *Service) InviteByEmail(ctx context.Context, audienceID, email, role string, withHistory bool) (string, error) {
	userID, err := s.ResolveEmail(ctx, email)
	if err != nil {
		return "", err
	}
	if _, aerr := s.AddMemberTOFU(ctx, audienceID, userID, role, withHistory); aerr != nil {
		return "", aerr
	}
	return userID, nil
}

// ResolveDisplayNames maps each user id to its published display name (empty
// when the user has published none). Best-effort per id: an unreadable identity
// is simply omitted. Used by the app layer to label shared entries by author
// without leaking display concerns into the decrypt path.
func (s *Service) ResolveDisplayNames(ctx context.Context, userIDs []string) (map[string]string, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(userIDs))
	for _, id := range userIDs {
		if _, done := out[id]; done {
			continue
		}
		if row, ierr := getIdentity(ctx, s.http, sess.base, sess.token, id); ierr == nil {
			out[id] = row.DisplayName
		}
	}
	return out, nil
}

// DeleteAudience deletes a team the caller created. ON DELETE CASCADE reaps its
// epochs, members, keys, grants, and shares server-side; the audiences DELETE
// policy confines this to the creator, so a non-creator gets a permission error.
func (s *Service) DeleteAudience(ctx context.Context, audienceID string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	return deleteAudience(ctx, s.http, sess.base, sess.token, audienceID)
}

// LeaveAudience removes the caller from a team they belong to but did not create.
// Unlike RemoveMember (an admin action that rotates the epoch for forward secrecy),
// leaving just deletes the caller's own membership row — the audience_members DELETE
// policy admits it because member_id is the caller. No epoch bump: a voluntary
// leaver already holds the current epoch key, so a hard cutoff is the admin's call
// (RemoveMember) if they want one; future rotations simply stop wrapping to them.
func (s *Service) LeaveAudience(ctx context.Context, audienceID string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	if derr := deleteMember(ctx, s.http, sess.base, sess.token, audienceID, sess.userID); derr != nil {
		return gerrors.Wrap(derr, "leave team")
	}
	return nil
}

// ListMembers returns one audience's roster with each member's pin status.
func (s *Service) ListMembers(ctx context.Context, audienceID string) ([]TeamMember, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	members, err := getMembers(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return nil, gerrors.Wrap(err, "list members")
	}
	out := make([]TeamMember, 0, len(members))
	for _, m := range members {
		_, pinned, ferr := s.pins.Fingerprint(m.MemberID)
		if ferr != nil {
			return nil, ferr
		}
		name := ""
		if idRow, ierr := getIdentity(ctx, s.http, sess.base, sess.token, m.MemberID); ierr == nil {
			name = idRow.DisplayName
		}
		out = append(out, TeamMember{
			UserID:      m.MemberID,
			Role:        m.Role,
			Pinned:      pinned,
			DisplayName: name,
			Status:      m.Status,
		})
	}
	return out, nil
}

// AcceptInvite accepts a pending invitation by flipping the caller's own
// membership row from 'invited' to 'active'. Only then do the team's shared
// entries, grants, and roster become visible to them (RLS gates every read on
// status='active'); the epoch keys they need were wrapped at invite time.
//
// Pinning is symmetric: the inviter TOFU-pinned this caller when adding them
// (AddMemberTOFU), but the caller has pinned no one. So once the roster is
// readable, TOFU-pin every other active member's published identity — otherwise
// the inviter (and everyone else) would render as unverified, and reading their
// shared entries would hard-fail on ErrNotPinned. Pinning is best-effort per
// member and never blocks the accept: a member already pinned to a DIFFERENT
// fingerprint is a real key change, surfaced later by the roster/read paths, not
// silently overwritten here.
func (s *Service) AcceptInvite(ctx context.Context, audienceID string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	if uerr := updateMemberStatus(ctx, s.http, sess.base, sess.token, audienceID, sess.userID, "active"); uerr != nil {
		return gerrors.Wrap(uerr, "accept invite")
	}
	s.pinRoster(ctx, sess, audienceID)
	return nil
}

// pinRoster TOFU-pins every active member of an audience other than the caller.
// Best-effort: a member with no published identity, or one already pinned
// (matching or conflicting), is skipped — Pin only records a first observation
// and returns nil on a matching re-pin. Called after a read becomes authorized
// (accept) so the caller trusts the roster it can now see.
func (s *Service) pinRoster(ctx context.Context, sess *sharingSession, audienceID string) {
	members, err := getMembers(ctx, s.http, sess.base, sess.token, audienceID)
	if err != nil {
		return
	}
	for _, m := range members {
		if m.MemberID == sess.userID || m.Status != "active" {
			continue
		}
		if _, pinned, ferr := s.pins.Fingerprint(m.MemberID); ferr != nil || pinned {
			continue
		}
		row, rerr := getIdentity(ctx, s.http, sess.base, sess.token, m.MemberID)
		if rerr != nil {
			continue
		}
		pub, perr := publicFromRow(row)
		if perr != nil {
			continue
		}
		_ = s.pins.Pin(m.MemberID, sharing.Fingerprint(pub))
	}
}
