package neonauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	gerrors "github.com/go-faster/errors"
)

// User is the subset of the Neon Auth (Better Auth) user record we render as
// identity. Field names match Better Auth's JSON.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Image string `json:"image"`
}

// session is what we persist to Keychain: the bearer session token, the raw
// session cookie, and the identity it belongs to, so Status can render without
// a network round-trip.
//
// Cookie is the signed `*.session_token` cookie Better Auth sets at sign-in. It
// is the durable credential used to mint short-lived Data API JWTs at /token;
// the bearer Token alone is rejected there (that endpoint authenticates by
// cookie), and it can't be reconstructed from Token since it carries an HMAC.
type session struct {
	Token  string `json:"token"`
	User   User   `json:"user"`
	Cookie string `json:"cookie,omitempty"`
}

func endpoint(base, path string) string {
	return strings.TrimRight(base, "/") + path
}

// hostOf returns the bare hostname of a URL, used for the offline reachability
// probe. Empty when the URL is unparseable or hostless.
func hostOf(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// originOf derives the scheme://host of a URL. Neon Auth (Better Auth) requires
// an Origin header on sign-up and validates it against its trusted origins; a
// request's own origin is trusted by default, so sending it needs no console
// configuration and works without a registered domain.
func originOf(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func signUpEmail(ctx context.Context, hc *http.Client, base, email, password, name string) (session, error) {
	return postCredentials(ctx, hc, endpoint(base, "/sign-up/email"), map[string]string{
		"email":    email,
		"password": password,
		"name":     name,
	})
}

func signInEmail(ctx context.Context, hc *http.Client, base, email, password string) (session, error) {
	return postCredentials(ctx, hc, endpoint(base, "/sign-in/email"), map[string]string{
		"email":    email,
		"password": password,
	})
}

// postCredentials drives the email sign-in/sign-up endpoints, which share a
// response shape: a JSON body carrying the user, and the session token both in
// the body (`token`) and in the bearer plugin's `set-auth-token` header. We
// prefer the header since that's the value subsequent Bearer requests carry.
func postCredentials(ctx context.Context, hc *http.Client, url string, body map[string]string) (session, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return session{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return session{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if origin := originOf(url); origin != "" {
		req.Header.Set("Origin", origin)
	}

	resp, err := hc.Do(req)
	if err != nil {
		return session{}, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return session{}, apiError(resp.StatusCode, data)
	}

	var out struct {
		Token string `json:"token"`
		User  User   `json:"user"`
	}
	if uerr := json.Unmarshal(data, &out); uerr != nil {
		return session{}, gerrors.Wrap(uerr, "decode auth response")
	}
	token := out.Token
	if h := resp.Header.Get("Set-Auth-Token"); h != "" {
		token = h
	}
	if token == "" {
		return session{}, gerrors.New("auth response contained no session token")
	}
	return session{Token: token, User: out.User, Cookie: sessionCookie(resp.Header)}, nil
}

// sessionCookie pulls the raw `name=value` of Better Auth's session-token cookie
// out of the response's Set-Cookie headers, verbatim (still percent-encoded and
// HMAC-signed), so it can be replayed as a Cookie header when minting a JWT.
// Returns "" when absent; a session without it simply can't mint Data API JWTs.
func sessionCookie(h http.Header) string {
	for _, c := range h["Set-Cookie"] {
		if !strings.Contains(c, "session_token=") {
			continue
		}
		if i := strings.IndexByte(c, ';'); i >= 0 {
			return c[:i]
		}
		return c
	}
	return ""
}

// mintJWT exchanges the session cookie for a short-lived Data API JWT via Better
// Auth's /token endpoint. The Data API validates this JWT against the project's
// JWKS and exposes its `sub` claim as auth.user_id(); the opaque session token
// is not a JWT and is rejected there.
func mintJWT(ctx context.Context, hc *http.Client, base, cookie string) (string, error) {
	if strings.TrimSpace(cookie) == "" {
		return "", gerrors.New("no session cookie; sign in again to enable sync")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint(base, "/token"), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Cookie", cookie)
	if origin := originOf(base); origin != "" {
		req.Header.Set("Origin", origin)
	}

	resp, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", apiError(resp.StatusCode, data)
	}
	var out struct {
		Token string `json:"token"`
	}
	if uerr := json.Unmarshal(data, &out); uerr != nil {
		return "", gerrors.Wrap(uerr, "decode token response")
	}
	if out.Token == "" {
		return "", gerrors.New("token response contained no JWT")
	}
	return out.Token, nil
}

// signOut revokes the session server-side. Best-effort: the caller deletes the
// local token regardless of the outcome.
func signOut(ctx context.Context, hc *http.Client, base, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(base, "/sign-out"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if origin := originOf(endpoint(base, "/sign-out")); origin != "" {
		req.Header.Set("Origin", origin)
	}

	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

// apiError extracts Better Auth's `{ "message", "code" }` error body so the UI
// can show the real reason ("Invalid email or password") rather than a status.
func apiError(status int, body []byte) error {
	var e struct {
		Message string `json:"message"`
		Code    string `json:"code"`
	}
	if json.Unmarshal(body, &e) == nil && e.Message != "" {
		return errors.New(e.Message)
	}
	return fmt.Errorf("neonauth: request failed (%d)", status)
}
