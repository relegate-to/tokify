package teams

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-faster/errors"
)

// Audience identifies which Teams API surface a token authorizes against.
// We only need one for status messages — the presence service — and that
// token's JWT claims carry the tenant + UPN we display.
type Audience string

const (
	AudiencePresence Audience = "presence"

	// Public Microsoft Teams web client app ID. Using this for unofficial
	// purposes is technically against MS policy; tenants with strict
	// Conditional Access may block it. See audit notes.
	teamsAppID = "5e3ce6c0-2b1f-4285-8d4b-75ee78787346"

	presenceResource = "https://presence.teams.microsoft.com"

	// The Teams web client always lands here after auth. We can't change this
	// because the redirect URI is bound to teamsAppID.
	redirectURI = "https://teams.microsoft.com/go"

	// tenantCommon is the multi-tenant AAD endpoint used until a successful
	// sign-in reveals the user's actual tenant.
	tenantCommon = "common"
)

// TokenSet is the full bag we persist per audience: the short-lived bearer
// we send to presence APIs, the long-lived refresh token we exchange for
// new bearers, and the absolute expiry of the access token (unix seconds).
//
// We use the v1 AAD endpoint with auth code + PKCE — that flow returns a
// refresh token for public clients without needing a client secret, and the
// refresh token is good for ~90 days with sliding renewal.
type TokenSet struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"`
}

func AllAudiences() []Audience {
	return []Audience{AudiencePresence}
}

func resourceFor(aud Audience) (string, error) {
	switch aud {
	case AudiencePresence:
		return presenceResource, nil
	default:
		return "", errors.Errorf("unknown audience: %s", aud)
	}
}

// BuildAuthURL builds the authorize URL for the given audience and returns
// the URL plus the PKCE verifier the caller must keep until the code comes
// back. tenantID is "common" until we've discovered the user's actual tenant
// from a successful sign-in.
//
// When silent is true, prompt=none is added so AAD will either redirect
// immediately using the session cookies present in the WKWebView, or bounce
// back with an interaction_required error. The caller must be ready to fall
// back to an interactive sign-in in the latter case.
func BuildAuthURL(aud Audience, tenantID string, silent bool) (string, string, error) {
	if tenantID == "" {
		tenantID = tenantCommon
	}
	resource, err := resourceFor(aud)
	if err != nil {
		return "", "", err
	}
	state, err := randomHex()
	if err != nil {
		return "", "", err
	}
	nonce, err := randomHex()
	if err != nil {
		return "", "", err
	}
	reqID, err := randomHex()
	if err != nil {
		return "", "", err
	}
	verifier, err := randomVerifier()
	if err != nil {
		return "", "", err
	}

	u, err := url.Parse("https://login.microsoftonline.com")
	if err != nil {
		return "", "", err
	}
	u.Path = "/" + tenantID + "/oauth2/authorize"

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("response_mode", "query")
	q.Set("client_id", teamsAppID)
	q.Set("redirect_uri", redirectURI)
	q.Set("resource", resource)
	q.Set("state", state+"|"+resource)
	q.Set("nonce", nonce)
	q.Set("client-request-id", reqID)
	q.Set("x-client-SKU", "Js")
	q.Set("x-client-Ver", "1.0.9")
	q.Set("code_challenge", pkceChallenge(verifier))
	q.Set("code_challenge_method", "S256")
	if silent {
		q.Set("prompt", "none")
	}
	u.RawQuery = q.Encode()
	return u.String(), verifier, nil
}

// ParseRedirect extracts the authorization code from the captured redirect
// URL. Errors include the AAD error code so the UI can show it verbatim.
func ParseRedirect(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("empty URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.Wrap(err, "parse URL")
	}
	if !strings.HasPrefix(u.Scheme+"://"+u.Host+u.Path, redirectURI) {
		return "", errors.Errorf("expected redirect to %s, got %s", redirectURI, u.Scheme+"://"+u.Host+u.Path)
	}
	vals := u.Query()
	if vals.Get("code") == "" && vals.Get("error") == "" && u.Fragment != "" {
		// Some intermediate hops put params in the fragment — accept both.
		f, ferr := url.ParseQuery(u.Fragment)
		if ferr != nil {
			return "", errors.Wrap(ferr, "parse fragment")
		}
		vals = f
	}
	if errCode := vals.Get("error"); errCode != "" {
		return "", errors.Errorf("auth error: %s — %s", errCode, vals.Get("error_description"))
	}
	if code := vals.Get("code"); code != "" {
		return code, nil
	}
	return "", errors.New("no code in redirect URL")
}

// ExchangeCode trades the authorization code (plus PKCE verifier) for a
// fresh TokenSet.
func ExchangeCode(ctx context.Context, hc *http.Client, tenantID, code, verifier string, aud Audience) (TokenSet, error) {
	if tenantID == "" {
		tenantID = tenantCommon
	}
	resource, err := resourceFor(aud)
	if err != nil {
		return TokenSet{}, err
	}
	form := url.Values{}
	form.Set("client_id", teamsAppID)
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("resource", resource)
	form.Set("code_verifier", verifier)
	return postToken(ctx, hc, tenantID, form, "")
}

// RefreshTokens exchanges a refresh token for a new TokenSet. AAD may rotate
// the refresh token; if the response omits one we keep the previous value so
// the caller can keep using it.
func RefreshTokens(ctx context.Context, hc *http.Client, tenantID, refreshToken string, aud Audience) (TokenSet, error) {
	if tenantID == "" {
		tenantID = tenantCommon
	}
	resource, err := resourceFor(aud)
	if err != nil {
		return TokenSet{}, err
	}
	form := url.Values{}
	form.Set("client_id", teamsAppID)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	form.Set("resource", resource)
	return postToken(ctx, hc, tenantID, form, refreshToken)
}

// postToken posts to the v1 token endpoint and decodes the response. If the
// response omits refresh_token, fallbackRefresh is carried into the result so
// callers using RefreshTokens don't accidentally drop a still-valid refresh
// token.
func postToken(ctx context.Context, hc *http.Client, tenantID string, form url.Values, fallbackRefresh string) (TokenSet, error) {
	endpoint := "https://login.microsoftonline.com/" + tenantID + "/oauth2/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return TokenSet{}, errors.Wrap(err, "new request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// The Teams app ID is registered as a Single-Page Application in AAD.
	// SPA tokens are only redeemable via cross-origin requests, which AAD
	// detects by the presence of an Origin header matching the redirect URI's
	// origin. Sending it makes our non-browser POST look like the real Teams
	// web client and avoids AADSTS9002327.
	req.Header.Set("Origin", "https://teams.microsoft.com")
	resp, err := hc.Do(req)
	if err != nil {
		return TokenSet{}, errors.Wrap(err, "do request")
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16384))
	if resp.StatusCode >= 400 {
		return TokenSet{}, errors.Errorf("token endpoint: HTTP %d %s", resp.StatusCode, string(body))
	}
	var r struct {
		AccessToken  string      `json:"access_token"`
		RefreshToken string      `json:"refresh_token"`
		ExpiresIn    json.Number `json:"expires_in"`
		ExpiresOn    json.Number `json:"expires_on"`
	}
	if uerr := json.Unmarshal(body, &r); uerr != nil {
		return TokenSet{}, errors.Wrap(uerr, "decode token response")
	}
	if r.AccessToken == "" {
		return TokenSet{}, errors.New("token response had no access_token")
	}
	expiresAt := int64(0)
	if r.ExpiresOn != "" {
		if n, perr := r.ExpiresOn.Int64(); perr == nil {
			expiresAt = n
		}
	}
	if expiresAt == 0 && r.ExpiresIn != "" {
		if n, perr := r.ExpiresIn.Int64(); perr == nil {
			expiresAt = time.Now().Unix() + n
		}
	}
	refresh := r.RefreshToken
	if refresh == "" {
		refresh = fallbackRefresh
	}
	return TokenSet{AccessToken: r.AccessToken, RefreshToken: refresh, ExpiresAt: expiresAt}, nil
}

func randomHex() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func randomVerifier() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
