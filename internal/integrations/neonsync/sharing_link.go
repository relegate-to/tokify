package neonsync

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"time"

	gerrors "github.com/go-faster/errors"
	"golang.org/x/crypto/hkdf"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// This file is the sender side of capability link shares (e2ee-sharing-link-
// shares.md): a one-off recipient with no account reads a filtered slice via a
// token-gated RPC. The crypto plane is the v2 machinery unchanged — each link
// gets its own dedicated audience (roster = the sender, frozen at epoch 1) plus
// a SYNTHETIC member that receives an ordinary epoch-key wrap but is never a
// row in audience_members. Only the *visibility* identity changes: from a Neon
// `sub` to a bearer capability whose single URL-fragment secret S derives both
// halves.

// Link derivation domain strings. Both derivations expand the one secret S
// under distinct HKDF info so the link stays a single opaque value while the
// visibility token and the readability KEK cannot be reversed into each other.
// Versioned and FROZEN once any link exists — a change invalidates outstanding
// links, exactly like the other domain constants in this package.
const (
	linkVisibilityInfo  = "tokify-link-visibility-v1"  // -> link token (hashed to token_hash), authorizes the RPC
	linkReadabilityInfo = "tokify-link-readability-v1" // -> S_read, the DeriveKEK password that unwraps the identity
)

// linkSecretLen is the byte length of the URL-fragment secret S: 128 bits, the
// §4/§9 minimum. A hashed high-entropy token needs no constant-time compare.
const linkSecretLen = 16

// LinkShare is what CreateLinkShare hands back: the dedicated audience id and
// the single secret S, URL-safe base64, that belongs in the link fragment
// (…/share/<audience-id>#<secret>). S never reaches the server; the fragment is
// its only copy (§7).
type LinkShare struct {
	AudienceID string
	Secret     string
}

// LinkShareInfo is one active link, for a list/revoke surface. Timestamps stay
// as the server's RFC3339 strings — a UI formats them; nothing here parses.
type LinkShareInfo struct {
	AudienceID string
	ValidUntil string
	Revoked    bool
	CreatedAt  string
}

// hkdfExpand reads n bytes from HKDF-SHA256 over the secret under info. The
// reader cannot short-read for these small lengths; any error is fatal misuse.
func hkdfExpand(secret []byte, info string, n int) []byte {
	r := hkdf.New(sha256.New, secret, nil, []byte(info))
	out := make([]byte, n)
	if _, err := io.ReadFull(r, out); err != nil {
		panic("neonsync: link hkdf: " + err.Error())
	}
	return out
}

// deriveLinkToken derives the visibility token from S: the value the recipient
// presents to sharing_link_fetch. Rendered lowercase hex so it round-trips as a
// PostgREST text argument, and this encoding is the frozen wire contract the RPC
// hashes against.
func deriveLinkToken(secret []byte) string {
	return hex.EncodeToString(hkdfExpand(secret, linkVisibilityInfo, keyLen))
}

// linkTokenHash is what the server stores: hex SHA-256 over the token's bytes,
// matching the RPC's encode(sha256(convert_to(link_token,'UTF8')),'hex').
func linkTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// deriveLinkKEK derives the readability KEK from S and the per-link salt. S_read
// is folded into DeriveKEK as its standard-base64 string — the frozen encoding
// of the DeriveKEK "password" for links (§9), so DeriveKEK is reused byte for
// byte with no email/login half on this path.
func deriveLinkKEK(secret, saltEnc []byte) []byte {
	read := hkdfExpand(secret, linkReadabilityInfo, keyLen)
	return DeriveKEK(base64.StdEncoding.EncodeToString(read), saltEnc)
}

// CreateLinkShare mints a capability link over the slice matching (projects,
// sinceDays): a dedicated audience, a synthetic recipient wrapped under the
// link-derived KEK, and a link_shares row token-hashed for the RPC. validFor
// bounds the link's lifetime (0 = indefinite, but a bounded value is
// recommended, §8). It returns the audience id and the secret for the URL
// fragment. The server only ever receives ciphertext and the token hash.
func (s *Service) CreateLinkShare(ctx context.Context, projects []string, sinceDays int, validFor time.Duration) (LinkShare, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return LinkShare{}, err
	}

	// A dedicated audience whose roster is only the sender (its self-admin
	// bootstrap), so epoch 1 is the only epoch it will ever have (§3), plus the
	// share filter that lets the reconcile grant-inserts pass §5.
	audienceID, err := s.CreateAudience(ctx)
	if err != nil {
		return LinkShare{}, err
	}
	if serr := s.SetShareFilter(ctx, audienceID, projects, sinceDays); serr != nil {
		return LinkShare{}, serr
	}

	localByID, err := s.completedLocalByID(ctx, sess.dek)
	if err != nil {
		return LinkShare{}, err
	}
	return s.provisionLinkRecipient(ctx, sess, audienceID, localByID, validFor)
}

// provisionLinkRecipient attaches a synthetic, accountless recipient to an
// already-bootstrapped link audience and materializes its grants. Split out so
// tests can drive it against a hand-built session/audience, mirroring the
// CreateAudience flow test. localByID is the sender's completed local entries.
func (s *Service) provisionLinkRecipient(
	ctx context.Context,
	sess *sharingSession,
	audienceID string,
	localByID map[string]models.Activity,
	validFor time.Duration,
) (LinkShare, error) {
	secret, err := randomBytes(linkSecretLen)
	if err != nil {
		return LinkShare{}, err
	}
	tokenHash := linkTokenHash(deriveLinkToken(secret))

	// The sender holds epoch 1 wrapped to themselves; unwrap it so it can be
	// re-wrapped to the synthetic member's identity pubkey.
	epochPriv, err := s.unwrapEpochKey(ctx, sess, audienceID, 1)
	if err != nil {
		return LinkShare{}, gerrors.Wrap(err, "unwrap link epoch key")
	}

	// The synthetic recipient: a member sub no Neon account backs (§3), an
	// identity keypair sealed under the link KEK, and the per-link salt.
	memberID, err := randomHexID()
	if err != nil {
		return LinkShare{}, err
	}
	salt, err := GenerateSalt()
	if err != nil {
		return LinkShare{}, err
	}
	kek := deriveLinkKEK(secret, salt)
	recipient, err := sharing.GenerateIdentity()
	if err != nil {
		return LinkShare{}, err
	}
	wrappedID, idNonce, err := sharing.WrapIdentity(recipient, kek, memberID)
	if err != nil {
		return LinkShare{}, err
	}

	// One ordinary epoch-key wrap to the synthetic member — its pubkey is used
	// in memory only and never stored in identities (§3, §5). The member is
	// deliberately NOT inserted into audience_members.
	if werr := s.wrapEpochToMembers(ctx, sess, audienceID, 1, epochPriv,
		[]memberKey{{id: memberID, encPub: recipient.Public().EncPub}}); werr != nil {
		return LinkShare{}, werr
	}

	// Trust bundle: the sender's signing pubkey sealed under the link KEK, so a
	// holder can verify author signatures the server can't forge (§7). The
	// server can't tamper with what it can't decrypt.
	tb, tbNonce, err := seal(kek, sess.id.Public().SigPub)
	if err != nil {
		return LinkShare{}, gerrors.Wrap(err, "seal trust bundle")
	}

	var validUntil *string
	if validFor > 0 {
		u := timeToParam(time.Now().Add(validFor))
		validUntil = &u
	}
	linkID, err := randomHexID()
	if err != nil {
		return LinkShare{}, err
	}
	if ierr := insertLinkShare(ctx, s.http, sess.base, sess.token, linkShareRow{
		ID:               linkID,
		AudienceID:       audienceID,
		TokenHash:        tokenHash,
		MemberID:         memberID,
		WrappedIdentity:  b64(wrappedID),
		IdentityNonce:    b64(idNonce),
		SaltEnc:          b64(salt),
		TrustBundle:      b64(tb),
		TrustBundleNonce: b64(tbNonce),
		CreatedBy:        sess.userID,
		ValidUntil:       validUntil,
	}); ierr != nil {
		return LinkShare{}, gerrors.Wrap(ierr, "insert link share")
	}

	// Materialize the audience's grants now so the link is usable immediately.
	// Entries must exist before grants (the grants FK), so push first — both
	// steps are idempotent and safe to repeat.
	if perr := s.pushSharedEntries(ctx, sess, localByID); perr != nil {
		return LinkShare{}, perr
	}
	if rerr := s.reconcileAudience(ctx, sess, audienceID, localByID, time.Now()); rerr != nil {
		return LinkShare{}, rerr
	}

	return LinkShare{AudienceID: audienceID, Secret: base64.RawURLEncoding.EncodeToString(secret)}, nil
}

// RevokeLinkShare kills a link and tears down its audience (§8): flip revoked so
// the RPC denies on the next call, then delete the dedicated audience so
// reconcile stops minting grants nobody can read and ON DELETE CASCADE reaps the
// epochs, keys, grants, and the link_shares row. There is no epoch bump — the
// roster never changed, so there is nothing to rotate.
func (s *Service) RevokeLinkShare(ctx context.Context, audienceID string) error {
	sess, err := s.session(ctx)
	if err != nil {
		return err
	}
	if rerr := revokeLinkShare(ctx, s.http, sess.base, sess.token, audienceID); rerr != nil {
		return gerrors.Wrap(rerr, "revoke link")
	}
	if derr := deleteAudience(ctx, s.http, sess.base, sess.token, audienceID); derr != nil {
		return gerrors.Wrap(derr, "delete link audience")
	}
	return nil
}

// ListLinkShares returns the caller's active links for a list/revoke surface.
func (s *Service) ListLinkShares(ctx context.Context) ([]LinkShareInfo, error) {
	sess, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := getLinkShares(ctx, s.http, sess.base, sess.token)
	if err != nil {
		return nil, err
	}
	out := make([]LinkShareInfo, 0, len(rows))
	for _, r := range rows {
		info := LinkShareInfo{AudienceID: r.AudienceID, Revoked: r.Revoked, CreatedAt: r.CreatedAt}
		if r.ValidUntil != nil {
			info.ValidUntil = *r.ValidUntil
		}
		out = append(out, info)
	}
	return out, nil
}

// completedLocalByID indexes the sender's completed local entries by content id,
// the same shape SyncNow builds. Running (open) entries have no final content
// and are skipped.
func (s *Service) completedLocalByID(ctx context.Context, dek []byte) (map[string]models.Activity, error) {
	local, err := s.activities.List(ctx, models.ActivityFilter{})
	if err != nil {
		return nil, gerrors.Wrap(err, "read local activities")
	}
	m := make(map[string]models.Activity, len(local))
	for _, act := range local {
		if act.EndTime == nil {
			continue
		}
		m[EntryID(dek, canonicalize(act))] = act
	}
	return m, nil
}
