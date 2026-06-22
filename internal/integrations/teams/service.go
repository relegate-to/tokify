package teams

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	gerrors "github.com/go-faster/errors"
)

// Service is the public surface used by the desktop app. It owns the keychain
// store, the HTTP client, and the cached in-memory settings. All methods are
// safe to call from any goroutine.
//
// Tokens are loaded from Keychain lazily on first use and re-loaded after a
// Connect / Disconnect transition. The Skype token (audience) is what we
// actually need to call presence APIs; the others are kept because the auth
// dance requires acquiring all three to mirror the Teams web client.
type Service struct {
	store      *keychainStore
	http       *httpClient
	settings   Settings
	settingsMu sync.RWMutex
	path       string
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
		store:    newKeychainStore(),
		http:     newHTTPClient(),
		settings: s,
		path:     path,
	}, nil
}

// Status returns the current connection + preference snapshot. Best-effort:
// Keychain failures are reported as "not connected" rather than surfaced as
// errors, since the frontend renders this on every settings open.
func (s *Service) Status() Status {
	s.settingsMu.RLock()
	enabled := s.settings.Enabled
	projects := append([]string(nil), s.settings.TrackedProjects...)
	s.settingsMu.RUnlock()

	out := Status{Enabled: enabled, TrackedProjects: projects}

	tok, err := s.store.Load(string(AudiencePresence))
	if err != nil {
		if errors.Is(err, errNotFound) {
			out.MissingTokens = []string{string(AudiencePresence)}
		}
		return out
	}
	if claims, err := decodeClaims(tok); err == nil {
		out.Connected = true
		out.TenantID = claims.TenantID
		out.UserUPN = claims.UPN
		out.Expires = claims.Expires
	}
	return out
}

// Connect runs the sign-in flow by spawning the tock-teams-auth helper
// subprocess. The helper opens a real WKWebView window, drives the
// Microsoft sign-in, and prints the captured redirect URL to stdout. We
// parse the URL and write the resulting presence-audience token to
// Keychain.
func (s *Service) Connect(ctx context.Context) error {
	helper, err := helperPath()
	if err != nil {
		return err
	}
	raw, err := runHelper(ctx, helper, AudiencePresence, "common")
	if err != nil {
		return gerrors.Wrap(err, "sign-in")
	}
	if _, err := s.SubmitRedirect(raw); err != nil {
		return gerrors.Wrap(err, "store token")
	}
	return nil
}

// SubmitRedirect ingests one redirect URL (typically from the auth helper,
// but exposed for tests / manual recovery). Identifies the audience via JWT
// claims and stores the token.
func (s *Service) SubmitRedirect(rawURL string) (string, error) {
	token, err := ParseRedirect(rawURL)
	if err != nil {
		return "", err
	}
	claims, err := decodeClaims(token)
	if err != nil {
		return "", gerrors.Wrap(err, "decode token")
	}
	aud := audienceFromClaim(claims.Audience)
	if aud == "" {
		return "", gerrors.Errorf("unrecognized token audience: %s", claims.Audience)
	}
	if err := s.store.Save(string(aud), token); err != nil {
		return "", err
	}
	return string(aud), nil
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
	if cwd, err := os.Getwd(); err == nil {
		// Walk up from cwd looking for go.mod; check bin/ at each level.
		dir := cwd
		for i := 0; i < 6; i++ {
			candidates = append(candidates, filepath.Join(dir, "bin", name))
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if info, err := os.Stat(abs); err == nil && !info.IsDir() {
			return abs, nil
		}
	}
	return "", gerrors.Errorf("tock-teams-auth helper not found; run `make teams-auth-build` (looked in %v)", candidates)
}

func runHelper(ctx context.Context, bin string, aud Audience, tenant string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, string(aud), tenant)
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
func (s *Service) Disconnect() error {
	var firstErr error
	for _, aud := range AllAudiences() {
		if err := s.store.Delete(string(aud)); err != nil && firstErr == nil {
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
// and we have a working Skype token. On Stop (empty description), the note is
// cleared.
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
	if !contains(tracked, project) {
		return nil
	}
	tok, err := s.store.Load(string(AudiencePresence))
	if err != nil {
		if errors.Is(err, errNotFound) {
			return nil
		}
		return err
	}
	if description == "" {
		return s.http.ClearNote(ctx, tok)
	}
	// Set a generous expiry; Teams will auto-clear it tomorrow if Toki
	// crashes mid-session.
	return s.http.PublishNote(ctx, tok, description, time.Now().Add(24*time.Hour))
}

func audienceFromClaim(aud string) Audience {
	if aud == presenceResource {
		return AudiencePresence
	}
	return ""
}

func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}
