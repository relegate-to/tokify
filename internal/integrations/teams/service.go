package teams

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	gerrors "github.com/go-faster/errors"
)

// ErrInteractionRequired means we cannot get a working access token without
// showing the user a real sign-in window. Returned when both the refresh
// token and the silent (prompt=none) WKWebView paths fail. Callers should
// either trigger Connect or surface a "reconnect" affordance to the user.
var ErrInteractionRequired = errors.New("teams: interactive sign-in required")

// Service is the public surface used by the desktop app. It owns the keychain
// store, the HTTP clients, and the cached in-memory settings. All methods are
// safe to call from any goroutine.
//
// Tokens are loaded from Keychain on every call rather than cached in memory:
// the keychain access is fast and avoids the synchronization headache of a
// cache that has to be invalidated on Connect / Disconnect / refresh.
type Service struct {
	store      *keychainStore
	http       *httpClient
	tokenHTTP  *http.Client
	settings   Settings
	settingsMu sync.RWMutex
	path       string
	refreshMu  sync.Mutex
}

// Status is the snapshot the frontend renders.
type Status struct {
	Connected       bool     `json:"connected"`
	UserUPN         string   `json:"user_upn,omitempty"`
	TenantID        string   `json:"tenant_id,omitempty"`
	Expires         int64    `json:"expires_unix,omitempty"` // unix seconds, 0 if unknown
	MissingTokens   []string `json:"missing_tokens,omitempty"`
	Enabled         bool     `json:"enabled"`
	TrackedProjects []string `json:"tracked_projects"`
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
	return &Service{
		store:     newKeychainStore(),
		http:      newHTTPClient(),
		tokenHTTP: &http.Client{Timeout: 15 * time.Second},
		settings:  s,
		path:      path,
	}, nil
}

// Status returns the current connection + preference snapshot. Best-effort:
// Keychain or token-decode failures are reported as "not connected" rather
// than surfaced as errors, since the frontend renders this on every settings
// open.
func (s *Service) Status() Status {
	s.settingsMu.RLock()
	enabled := s.settings.Enabled
	projects := append([]string(nil), s.settings.TrackedProjects...)
	s.settingsMu.RUnlock()

	out := Status{Enabled: enabled, TrackedProjects: projects}

	tok, err := s.loadTokens(context.Background())
	if err != nil {
		if errors.Is(err, errNotFound) {
			out.MissingTokens = []string{string(AudiencePresence)}
		}
		return out
	}
	if claims, cerr := decodeClaims(tok.AccessToken); cerr == nil {
		out.Connected = true
		out.TenantID = claims.TenantID
		out.UserUPN = claims.UPN
		out.Expires = tok.ExpiresAt
	}
	return out
}

// Connect runs the sign-in flow by spawning the tock-teams-auth helper
// subprocess. The helper opens a real WKWebView window, drives the
// Microsoft sign-in, and prints the captured redirect URL to stdout. We
// parse the code out of that URL, exchange it for an access+refresh token
// pair, and persist the pair to Keychain.
func (s *Service) Connect(ctx context.Context) error {
	helper, err := helperPath()
	if err != nil {
		return err
	}
	authURL, verifier, err := BuildAuthURL(AudiencePresence, tenantCommon, false)
	if err != nil {
		return gerrors.Wrap(err, "build auth url")
	}
	raw, err := runHelper(ctx, helper, authURL, false)
	if err != nil {
		return gerrors.Wrap(err, "sign-in")
	}
	code, err := ParseRedirect(raw)
	if err != nil {
		return gerrors.Wrap(err, "parse redirect")
	}
	tokens, err := ExchangeCode(ctx, s.tokenHTTP, tenantCommon, code, verifier, AudiencePresence)
	if err != nil {
		return gerrors.Wrap(err, "exchange code")
	}
	if serr := s.saveTokens(ctx, tokens); serr != nil {
		return gerrors.Wrap(serr, "persist tokens")
	}
	return nil
}

// helperPath locates the tock-teams-auth binary. In a packaged .app it lives
// next to the main binary in Contents/MacOS/. In Wails dev mode the binary
// runs from a temp directory, so we also walk the cwd upwards looking for a
// `bin/tock-teams-auth` next to a go.mod. The TOKI_TEAMS_AUTH_BIN env var
// short-circuits everything for debugging or alternative install layouts.
func helperPath() (string, error) {
	const name = "tock-teams-auth"
	if env := strings.TrimSpace(os.Getenv("TOKI_TEAMS_AUTH_BIN")); env != "" {
		return env, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", gerrors.Wrap(err, "locate self")
	}
	candidates := []string{
		filepath.Join(filepath.Dir(self), name), // .app/Contents/MacOS/<binary>
	}
	if cwd, cerr := os.Getwd(); cerr == nil {
		dir := cwd
		for range 6 {
			candidates = append(candidates, filepath.Join(dir, "bin", name))
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	for _, c := range candidates {
		abs, aerr := filepath.Abs(c)
		if aerr != nil {
			continue
		}
		if info, serr := os.Stat(abs); serr == nil && !info.IsDir() {
			return abs, nil
		}
	}
	return "", gerrors.Errorf("tock-teams-auth helper not found; run `make teams-auth-build` (looked in %v)", candidates)
}

func runHelper(ctx context.Context, bin, authURL string, silent bool) (string, error) {
	args := []string{authURL}
	if silent {
		args = []string{"--silent", authURL}
	}
	// bin is resolved by helperPath() from a fixed search list, not user input.
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// Exit 2 from the helper means the user closed the window. Surface
		// that as a clean cancel rather than a generic error so the UI can
		// distinguish it.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
			return "", gerrors.New("sign-in cancelled")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return "", gerrors.Wrap(err, msg)
		}
		return "", err
	}
	out := strings.TrimSpace(stdout.String())
	if out == "" {
		return "", gerrors.New("helper returned no URL")
	}
	return out, nil
}

// Disconnect deletes all stored tokens. Settings (enabled, projects) are left
// alone so re-connecting later doesn't lose the user's project allowlist.
func (s *Service) Disconnect(ctx context.Context) error {
	var firstErr error
	for _, aud := range AllAudiences() {
		if err := s.store.Delete(ctx, string(aud)); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// SetEnabled flips the master switch.
func (s *Service) SetEnabled(v bool) error {
	s.settingsMu.Lock()
	s.settings.Enabled = v
	snapshot := s.settings
	s.settingsMu.Unlock()
	return saveSettings(s.path, snapshot)
}

// SetTrackedProjects replaces the project allowlist.
func (s *Service) SetTrackedProjects(projects []string) error {
	clean := make([]string, 0, len(projects))
	seen := map[string]struct{}{}
	for _, p := range projects {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		clean = append(clean, p)
	}
	s.settingsMu.Lock()
	s.settings.TrackedProjects = clean
	snapshot := s.settings
	s.settingsMu.Unlock()
	return saveSettings(s.path, snapshot)
}

// PushActivityStatus is called by the desktop app on every Start/Stop. It's a
// no-op unless the integration is enabled, the project is in the allowlist,
// and we have a working presence token. On Stop (empty description), the note
// is cleared.
//
// Errors are returned so callers can decide whether to surface them; the
// activity transition itself must not be blocked on this side effect.
func (s *Service) PushActivityStatus(ctx context.Context, description, project string) error {
	s.settingsMu.RLock()
	enabled := s.settings.Enabled
	tracked := s.settings.TrackedProjects
	s.settingsMu.RUnlock()
	if !enabled {
		return nil
	}
	if !slices.Contains(tracked, project) {
		return nil
	}
	accessToken, err := s.accessToken(ctx)
	if err != nil {
		if errors.Is(err, errNotFound) {
			return nil
		}
		return err
	}
	if description == "" {
		return s.http.ClearNote(ctx, accessToken)
	}
	// Generous expiry; Teams will auto-clear it tomorrow if Toki crashes
	// mid-session.
	return s.http.PublishNote(ctx, accessToken, description, time.Now().Add(24*time.Hour))
}

// accessToken returns a live access token. Two upgrade paths when the cached
// access token is expired or near expiry:
//
//  1. Refresh-token grant. SPA refresh tokens cap at ~24h absolute lifetime,
//     so this covers "Toki was closed overnight" but not "Toki sat idle for
//     a weekend".
//  2. Silent re-auth via the helper with prompt=none. Reuses the persistent
//     WKWebView cookie jar from the prior interactive sign-in; the
//     login.microsoftonline.com session cookies last days to weeks
//     depending on tenant policy.
//
// Serialized so concurrent pushes don't burn two refresh round-trips.
func (s *Service) accessToken(ctx context.Context) (string, error) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	tok, err := s.loadTokens(ctx)
	if err != nil {
		return "", err
	}
	if tok.ExpiresAt > time.Now().Add(60*time.Second).Unix() {
		return tok.AccessToken, nil
	}
	tenant := tenantCommon
	if claims, derr := decodeClaims(tok.AccessToken); derr == nil && claims.TenantID != "" {
		tenant = claims.TenantID
	}
	if tok.RefreshToken != "" {
		next, rerr := RefreshTokens(ctx, s.tokenHTTP, tenant, tok.RefreshToken, AudiencePresence)
		if rerr == nil {
			if serr := s.saveTokens(ctx, next); serr != nil {
				return "", gerrors.Wrap(serr, "persist refreshed tokens")
			}
			return next.AccessToken, nil
		}
		// Refresh token rejected (typically expired past the SPA 24h cap).
		// Fall through to silent re-auth.
	}
	next, err := s.silentReauth(ctx, tenant)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInteractionRequired, err)
	}
	if serr := s.saveTokens(ctx, next); serr != nil {
		return "", gerrors.Wrap(serr, "persist reauthed tokens")
	}
	return next.AccessToken, nil
}

// silentReauth runs the auth helper with prompt=none in a hidden window and
// exchanges the resulting code for fresh tokens. Returns an error if AAD
// requires interaction; accessToken converts that into ErrInteractionRequired
// so the desktop layer can pop the real sign-in window.
func (s *Service) silentReauth(ctx context.Context, tenant string) (TokenSet, error) {
	helper, err := helperPath()
	if err != nil {
		return TokenSet{}, err
	}
	authURL, verifier, err := BuildAuthURL(AudiencePresence, tenant, true)
	if err != nil {
		return TokenSet{}, gerrors.Wrap(err, "build silent auth url")
	}
	raw, err := runHelper(ctx, helper, authURL, true)
	if err != nil {
		return TokenSet{}, err
	}
	code, err := ParseRedirect(raw)
	if err != nil {
		return TokenSet{}, err
	}
	return ExchangeCode(ctx, s.tokenHTTP, tenant, code, verifier, AudiencePresence)
}

func (s *Service) loadTokens(ctx context.Context) (TokenSet, error) {
	raw, err := s.store.Load(ctx, string(AudiencePresence))
	if err != nil {
		return TokenSet{}, err
	}
	var tok TokenSet
	if uerr := json.Unmarshal([]byte(raw), &tok); uerr != nil {
		// Pre-PKCE installs stored the raw access token. Treat that as "no
		// tokens" so the UI prompts a reconnect.
		return TokenSet{}, errNotFound
	}
	return tok, nil
}

func (s *Service) saveTokens(ctx context.Context, tok TokenSet) error {
	// Serializing the token set for Keychain storage is the whole point here;
	// the access/refresh tokens are meant to be persisted, not leaked.
	data, err := json.Marshal(tok) //nolint:gosec // G117: tokens are intentionally serialized for Keychain
	if err != nil {
		return err
	}
	return s.store.Save(ctx, string(AudiencePresence), string(data))
}
