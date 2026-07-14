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
}

// TeamMember is one row of an audience's roster plus whether the caller has
// pin-verified that member's identity fingerprint. Unpinned members are still
// returned (TOFU): the UI shows them so it can offer to pin, and a later key
// change trips the watermark rather than blocking the invite up front.
type TeamMember struct {
	UserID string
	Role   string
	Pinned bool
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
		role := ""
		for _, m := range members {
			if m.MemberID == sess.userID {
				role = m.Role
				break
			}
		}
		out = append(out, TeamInfo{
			ID:           aud.ID,
			Role:         role,
			MemberCount:  len(members),
			CurrentEpoch: aud.CurrentEpoch,
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
		out = append(out, TeamMember{UserID: m.MemberID, Role: m.Role, Pinned: pinned})
	}
	return out, nil
}
