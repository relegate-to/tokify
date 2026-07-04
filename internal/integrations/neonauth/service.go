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
)

// ErrNotConfigured is returned by sign-in/sign-up when no Auth URL has been set.
var ErrNotConfigured = errors.New("neonauth: no Auth URL configured")

// keychainAccount is the single slot we store the session under; only one
// account can be signed in at a time.
const keychainAccount = "session"

// Service is the public surface used by the desktop app. It owns the keychain
// store, an HTTP client, and the cached Auth URL. All methods are safe to call
// from any goroutine.
//
// The session is loaded from Keychain on each call rather than cached in
// memory, matching the Teams integration: Keychain access is fast and avoids
// invalidating a cache on SignIn / SignOut.
type Service struct {
	store *keychainStore
	http  *http.Client

	mu       sync.RWMutex
	settings Settings
	path     string
}

// Status is the snapshot the frontend renders. Absence of a session is
// reported via SignedIn=false, never as an error.
type Status struct {
	Configured bool   `json:"configured"`
	SignedIn   bool   `json:"signed_in"`
	UserID     string `json:"user_id,omitempty"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
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
	// TOKI_NEON_AUTH_URL lets you point at a Neon project without editing the
	// JSON — handy in dev and on first run before the settings file exists.
	if env := strings.TrimSpace(os.Getenv("TOKI_NEON_AUTH_URL")); env != "" {
		s.AuthURL = env
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
	return out
}

// SignIn authenticates with email + password and persists the session.
func (s *Service) SignIn(ctx context.Context, email, password string) (Status, error) {
	base := s.authURL()
	if base == "" {
		return Status{}, ErrNotConfigured
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

// SignUp creates an account with email + password and persists the session.
func (s *Service) SignUp(ctx context.Context, email, password, name string) (Status, error) {
	base := s.authURL()
	if base == "" {
		return Status{}, ErrNotConfigured
	}
	sess, err := signUpEmail(ctx, s.http, base, email, password, name)
	if err != nil {
		return Status{}, err
	}
	if serr := s.saveSession(ctx, sess); serr != nil {
		return Status{}, gerrors.Wrap(serr, "persist session")
	}
	return s.Status(), nil
}

// SignOut revokes the session server-side (best-effort) and deletes the local
// token so the app returns to the signed-out state.
func (s *Service) SignOut(ctx context.Context) error {
	if sess, err := s.loadSession(ctx); err == nil {
		if base := s.authURL(); base != "" {
			_ = signOut(ctx, s.http, base, sess.Token)
		}
	}
	return s.store.Delete(ctx, keychainAccount)
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
