package neonauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/integrations/netcheck"
)

// ErrNotConfigured is returned by sign-in/sign-up when no Auth URL has been set.
var ErrNotConfigured = errors.New("neonauth: no Auth URL configured")

// keychainAccount is the single slot we store the session under; only one
// account can be signed in at a time.
const keychainAccount = "session"

// How early a cached JWT is treated as spent, and the lifetime assumed for one
// whose `exp` claim can't be read. The margin covers clock skew plus the
// round-trip of whatever request the token is about to authenticate.
const (
	tokenRefreshMargin = 60 * time.Second
	tokenFallbackTTL   = 5 * time.Minute
)

// maxAvatarBytes caps the profile picture UpdateAvatar will send. An avatar is
// stored inline as a data: URI on the account record and republished onto the
// public sharing identity, so an oversized one is paid for again on every
// roster read. The frontend downscales to a small square far below this; the
// cap is the backstop against a caller that doesn't.
const maxAvatarBytes = 256 << 10

// DefaultAuthURL is the Neon Auth endpoint baked into release builds via
// -ldflags (see the desktop-build Makefile targets). It's empty in source so
// the package stays deployment-agnostic; local dev leaves it unset and relies
// on TOKIFY_NEON_AUTH_URL or the settings file instead.
//
//nolint:gochecknoglobals // ldflags injection target; must be a package var.
var DefaultAuthURL string

// Service is the public surface used by the desktop app. It owns the keychain
// store, an HTTP client, and the cached Auth URL. All methods are safe to call
// from any goroutine.
//
// The session is loaded from Keychain on each call rather than cached in
// memory. Keychain access is fast and avoids invalidating a cache on sign-in or
// sign-out.
type Service struct {
	store *keychainStore
	http  *http.Client

	mu       sync.RWMutex
	settings Settings
	path     string

	// The minted Data API JWT, shared by every caller until it nears expiry.
	// Keyed by the session cookie it was minted from, so a sign-out/sign-in
	// cycle can never hand back the previous account's token.
	tokenMu     sync.Mutex
	token       string
	tokenCookie string
	tokenExp    time.Time
}

// Status is the snapshot the frontend renders. Absence of a session is
// reported via SignedIn=false, never as an error.
type Status struct {
	Configured bool   `json:"configured"`
	SignedIn   bool   `json:"signed_in"`
	UserID     string `json:"user_id,omitempty"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
	// Image is the account's profile picture: a data: URI (what UpdateAvatar
	// writes) or an https URL, empty when none has been set.
	Image string `json:"image,omitempty"`
	// PendingVerification is set when the account exists and a code was emailed
	// but no session is issued until VerifyEmail confirms it — either sign-up
	// just created it, or sign-in found it still unverified from an earlier one.
	PendingVerification bool `json:"pending_verification,omitempty"`
}

func NewService() (*Service, error) {
	path, err := defaultSettingsPath()
	if err != nil {
		return nil, err
	}
	s, err := loadSettings(path)
	if err != nil {
		return nil, err
	}
	// TOKIFY_NEON_AUTH_URL lets you point at a Neon project without editing the
	// JSON — handy in dev and on first run before the settings file exists.
	if env := strings.TrimSpace(os.Getenv("TOKIFY_NEON_AUTH_URL")); env != "" {
		s.AuthURL = env
	} else if strings.TrimSpace(s.AuthURL) == "" {
		s.AuthURL = DefaultAuthURL
	}
	return &Service{
		store:    newKeychainStore(),
		http:     &http.Client{Timeout: 20 * time.Second},
		settings: s,
		path:     path,
	}, nil
}

func (s *Service) authURL() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return strings.TrimSpace(s.settings.AuthURL)
}

// SetAuthURL points the service at a Neon Auth project and persists it.
func (s *Service) SetAuthURL(url string) error {
	s.mu.Lock()
	s.settings.AuthURL = strings.TrimSpace(url)
	snapshot := s.settings
	s.mu.Unlock()
	return saveSettings(s.path, snapshot)
}

// Status returns the current configuration + sign-in snapshot. Best-effort:
// a missing or unreadable session is reported as signed-out, since the
// frontend renders this on every Account open.
func (s *Service) Status() Status {
	out := Status{Configured: s.authURL() != ""}
	sess, err := s.loadSession(context.Background())
	if err != nil {
		return out
	}
	out.SignedIn = true
	out.UserID = sess.User.ID
	out.Email = sess.User.Email
	out.Name = sess.User.Name
	out.Image = sess.User.Image
	return out
}

// UpdateAvatar sets the signed-in account's profile picture and mirrors it onto
// the stored session, so the next Status renders it without a refetch. The image
// is a self-contained data: URI (or an https URL); an empty string clears the
// avatar and falls the UI back to initials.
func (s *Service) UpdateAvatar(ctx context.Context, image string) (Status, error) {
	base := s.authURL()
	if base == "" {
		return Status{}, ErrNotConfigured
	}
	image = strings.TrimSpace(image)
	if len(image) > maxAvatarBytes {
		return Status{}, gerrors.New("that picture is too large; try a smaller one")
	}
	sess, err := s.loadSession(ctx)
	if err != nil {
		return Status{}, err
	}
	// The cookie, not the bearer token, is what /update-user accepts. A session
	// stored without one can't write the profile at all, so say so plainly rather
	// than letting the server answer with a bare 401.
	if strings.TrimSpace(sess.Cookie) == "" {
		return Status{}, gerrors.New("sign in again to change your picture")
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return Status{}, netcheck.ErrOffline
	}
	if uerr := updateImage(ctx, s.http, base, sess.Cookie, image); uerr != nil {
		return Status{}, uerr
	}
	sess.User.Image = image
	if serr := s.saveSession(ctx, sess); serr != nil {
		return Status{}, gerrors.Wrap(serr, "persist session")
	}
	return s.Status(), nil
}

// SignIn authenticates with email + password and persists the session. An
// account whose email was never verified is not an error: it returns a
// PendingVerification status so the caller can finish the interrupted sign-up.
func (s *Service) SignIn(ctx context.Context, email, password string) (Status, error) {
	base := s.authURL()
	if base == "" {
		return Status{}, ErrNotConfigured
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return Status{}, netcheck.ErrOffline
	}
	sess, err := signInEmail(ctx, s.http, base, email, password)
	if err != nil {
		if !isEmailNotVerified(err) {
			return Status{}, err
		}
		// The account exists but its email was never confirmed: sign-up's code
		// was abandoned, lost, or expired. Reporting the refusal verbatim leaves
		// the user with no way forward, so mail a fresh code and route the UI to
		// the same verification step sign-up uses. The resend is best-effort —
		// if it fails (rate limits, most likely) the earlier code may still be
		// valid, and the verification step offers a resend of its own.
		_ = sendVerificationOTP(ctx, s.http, base, email)
		return Status{Configured: true, PendingVerification: true, Email: email}, nil
	}
	if serr := s.saveSession(ctx, sess); serr != nil {
		return Status{}, gerrors.Wrap(serr, "persist session")
	}
	return s.Status(), nil
}

// SignUp creates an account with email + password and persists the session.
func (s *Service) SignUp(ctx context.Context, email, password, name string) (Status, error) {
	base := s.authURL()
	if base == "" {
		return Status{}, ErrNotConfigured
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return Status{}, netcheck.ErrOffline
	}
	sess, err := signUpEmail(ctx, s.http, base, email, password, name)
	if err != nil {
		return Status{}, err
	}
	if sess.Token == "" {
		// The project requires email verification: the account was created and a
		// code emailed, but no session is issued yet. Report it so the UI prompts
		// for the code instead of treating this as a failure.
		return Status{Configured: true, PendingVerification: true, Email: email, Name: name}, nil
	}
	if serr := s.saveSession(ctx, sess); serr != nil {
		return Status{}, gerrors.Wrap(serr, "persist session")
	}
	return s.Status(), nil
}

// VerifyEmail confirms the emailed OTP and then signs in to obtain a session.
// Sign-up withholds the session pending verification, so a fresh sign-in is the
// deterministic way to establish one once the email is confirmed.
func (s *Service) VerifyEmail(ctx context.Context, email, password, otp string) (Status, error) {
	base := s.authURL()
	if base == "" {
		return Status{}, ErrNotConfigured
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return Status{}, netcheck.ErrOffline
	}
	if err := verifyEmailOTP(ctx, s.http, base, email, otp); err != nil {
		return Status{}, err
	}
	sess, err := signInEmail(ctx, s.http, base, email, password)
	if err != nil {
		return Status{}, err
	}
	if serr := s.saveSession(ctx, sess); serr != nil {
		return Status{}, gerrors.Wrap(serr, "persist session")
	}
	return s.Status(), nil
}

// ResendVerification asks Neon Auth to email a fresh verification code.
func (s *Service) ResendVerification(ctx context.Context, email string) error {
	base := s.authURL()
	if base == "" {
		return ErrNotConfigured
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return netcheck.ErrOffline
	}
	return sendVerificationOTP(ctx, s.http, base, email)
}

// SignOut revokes the session server-side (best-effort) and deletes the local
// token so the app returns to the signed-out state.
func (s *Service) SignOut(ctx context.Context) error {
	if sess, err := s.loadSession(ctx); err == nil {
		// Revoking the session is best-effort; skip it entirely when offline so
		// we don't stall on a dial. The local token is deleted below regardless,
		// which is what actually signs the user out on this device.
		if base := s.authURL(); base != "" && netcheck.Online(ctx, hostOf(base)) {
			_ = signOut(ctx, s.http, base, sess.Token)
		}
	}
	s.forgetToken()
	return s.store.Delete(ctx, keychainAccount)
}

// Token returns a short-lived Data API JWT for callers that need to make
// authenticated Data API requests (the neonsync integration). The stored
// session token is opaque and rejected by the Data API, so this exchanges the
// session cookie for a JWT at Neon Auth's /token endpoint. Returns an error
// when signed out, so callers can treat "no token" as "not signed in".
//
// The JWT is cached until it nears expiry, and only one mint runs at a time.
// Minting per call instead put a request on the auth endpoint for every sharing
// operation: opening a screen that fans out several at once (Teams asks for the
// team list plus one share view per team) sent a burst of mints in parallel and
// tripped Neon Auth's rate limiter.
func (s *Service) Token(ctx context.Context) (string, error) {
	sess, err := s.loadSession(ctx)
	if err != nil {
		return "", err
	}
	base := s.authURL()
	if base == "" {
		return "", ErrNotConfigured
	}

	// Held across the mint so concurrent callers queue behind one request and
	// then read its result from the cache, rather than each firing their own.
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()

	if s.token != "" && s.tokenCookie == sess.Cookie && time.Now().Before(s.tokenExp) {
		return s.token, nil
	}

	token, err := mintJWT(ctx, s.http, base, sess.Cookie)
	if err != nil {
		return "", err
	}
	s.token = token
	s.tokenCookie = sess.Cookie
	if exp, ok := jwtExpiry(token); ok {
		s.tokenExp = exp.Add(-tokenRefreshMargin)
	} else {
		s.tokenExp = time.Now().Add(tokenFallbackTTL)
	}
	return token, nil
}

// forgetToken drops the cached JWT. Called on sign-out so a revoked session
// leaves no usable credential behind in memory.
func (s *Service) forgetToken() {
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	s.token = ""
	s.tokenCookie = ""
	s.tokenExp = time.Time{}
}

func (s *Service) loadSession(ctx context.Context) (session, error) {
	raw, err := s.store.Load(ctx, keychainAccount)
	if err != nil {
		return session{}, err
	}
	var sess session
	if uerr := json.Unmarshal([]byte(raw), &sess); uerr != nil || sess.Token == "" {
		return session{}, errNotFound
	}
	return sess, nil
}

func (s *Service) saveSession(ctx context.Context, sess session) error {
	// Serializing the session for Keychain storage is the whole point here; the
	// token is meant to be persisted, not leaked.
	data, err := json.Marshal(sess)
	if err != nil {
		return err
	}
	return s.store.Save(ctx, keychainAccount, string(data))
}
