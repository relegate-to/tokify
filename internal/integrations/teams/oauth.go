package teams

import (
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"strings"

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
)

func AllAudiences() []Audience {
	return []Audience{AudiencePresence}
}

// LoginURL builds the OAuth authorize URL for the given audience and tenant.
// tenantID is "common" until we've discovered the user's actual tenant from
// the first (teams) token.
func LoginURL(aud Audience, tenantID string) (string, error) {
	if tenantID == "" {
		tenantID = "common"
	}
	state, err := randomHex()
	if err != nil {
		return "", err
	}
	nonce, err := randomHex()
	if err != nil {
		return "", err
	}
	reqID, err := randomHex()
	if err != nil {
		return "", err
	}

	u, err := url.Parse("https://login.microsoftonline.com")
	if err != nil {
		return "", err
	}
	u.Path = "/" + tenantID + "/oauth2/authorize"

	q := url.Values{}
	switch aud {
	case AudiencePresence:
		q.Set("response_type", "token")
		q.Set("state", state+"|"+presenceResource)
		q.Set("resource", presenceResource)
	default:
		return "", errors.Errorf("unknown audience: %s", aud)
	}
	q.Set("client_id", teamsAppID)
	q.Set("client-request-id", reqID)
	q.Set("redirect_uri", redirectURI)
	q.Set("x-client-SKU", "Js")
	q.Set("x-client-Ver", "1.0.9")
	q.Set("nonce", nonce)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ParseRedirect extracts id_token / access_token from a URL the user captured
// after completing the auth flow. The token of interest lives in the URL
// fragment. Returns an error if the URL is the wrong one or doesn't carry a
// token (e.g. user pasted login.microsoftonline.com/error/...).
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
	// Tokens live in the fragment, not the query.
	frag := u.Fragment
	if frag == "" {
		// Fall back to query in case the user's browser rewrote it.
		frag = u.RawQuery
	}
	vals, err := url.ParseQuery(frag)
	if err != nil {
		return "", errors.Wrap(err, "parse fragment")
	}
	if errCode := vals.Get("error"); errCode != "" {
		return "", errors.Errorf("auth error: %s — %s", errCode, vals.Get("error_description"))
	}
	if t := vals.Get("id_token"); t != "" {
		return t, nil
	}
	if t := vals.Get("access_token"); t != "" {
		return t, nil
	}
	return "", errors.New("no token in redirect URL")
}

func randomHex() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
