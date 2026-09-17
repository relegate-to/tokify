package neonauth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func jwtWithClaims(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func TestJWTExpiry(t *testing.T) {
	exp := time.Now().Add(time.Hour).Truncate(time.Second)

	got, ok := jwtExpiry(jwtWithClaims(t, map[string]any{"exp": exp.Unix(), "sub": "u1"}))
	if !ok {
		t.Fatal("expected the exp claim to be read")
	}
	if !got.Equal(exp) {
		t.Fatalf("expiry = %v, want %v", got, exp)
	}
}

// An unreadable token must report false rather than a zero time, so Token falls
// back to a conservative lifetime instead of treating the JWT as long expired
// and re-minting on every call.
func TestJWTExpiryUnreadable(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"not a jwt":        "opaque-session-token",
		"two segments":     "header.payload",
		"payload not b64":  "header.!!!not-base64!!!.signature",
		"payload not json": "header." + base64.RawURLEncoding.EncodeToString([]byte("nope")) + ".signature",
		"no exp claim":     jwtWithClaims(t, map[string]any{"sub": "u1"}),
		"zero exp":         jwtWithClaims(t, map[string]any{"exp": 0}),
		"negative exp":     jwtWithClaims(t, map[string]any{"exp": -1}),
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := jwtExpiry(token); ok {
				t.Fatal("expected the token to be reported unreadable")
			}
		})
	}
}

// The cache is only safe if the margin is subtracted from a real expiry: a token
// minted now must be reused, and one already inside the margin must not be.
func TestTokenRefreshMarginLeavesTokenUsable(t *testing.T) {
	fresh, ok := jwtExpiry(jwtWithClaims(t, map[string]any{"exp": time.Now().Add(time.Hour).Unix()}))
	if !ok {
		t.Fatal("expected a readable expiry")
	}
	if !time.Now().Before(fresh.Add(-tokenRefreshMargin)) {
		t.Fatal("a freshly minted hour-long token should still be cacheable")
	}

	stale, ok := jwtExpiry(jwtWithClaims(t, map[string]any{"exp": time.Now().Add(tokenRefreshMargin / 2).Unix()}))
	if !ok {
		t.Fatal("expected a readable expiry")
	}
	if time.Now().Before(stale.Add(-tokenRefreshMargin)) {
		t.Fatal("a token inside the refresh margin should be treated as spent")
	}
}

// Sign-in against an account that never confirmed its email must be
// recognisable, since SignIn turns it into a verification prompt rather than a
// dead end. Both shapes Neon Auth has returned are covered.
func TestIsEmailNotVerified(t *testing.T) {
	verified := map[string]string{
		"code":         `{"code":"EMAIL_NOT_VERIFIED","message":"Email not verified"}`,
		"message only": `{"message":"Email not verified"}`,
	}
	for name, body := range verified {
		t.Run(name, func(t *testing.T) {
			if !isEmailNotVerified(apiError(http.StatusForbidden, []byte(body))) {
				t.Fatal("expected an unverified-email refusal to be recognised")
			}
		})
	}

	other := map[string]error{
		"bad credentials": apiError(http.StatusUnauthorized,
			[]byte(`{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}`)),
		"no error body": apiError(http.StatusInternalServerError, nil),
		"transport":     errors.New("dial tcp: connection refused"),
		"nil":           nil,
	}
	for name, err := range other {
		t.Run(name, func(t *testing.T) {
			if isEmailNotVerified(err) {
				t.Fatalf("%v must not be read as an unverified email", err)
			}
		})
	}
}

// The refusal must still reach the UI as Better Auth's own wording; carrying the
// code alongside it is what lets SignIn branch without losing the message.
func TestAPIErrorKeepsMessage(t *testing.T) {
	err := apiError(http.StatusForbidden, []byte(`{"code":"EMAIL_NOT_VERIFIED","message":"Email not verified"}`))
	if err.Error() != "Email not verified" {
		t.Fatalf("message = %q, want %q", err.Error(), "Email not verified")
	}
}

// The unverified-email response has to survive the sign-in round-trip as a
// recognisable error, not be flattened into a generic status failure.
func TestSignInEmailSurfacesUnverified(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"EMAIL_NOT_VERIFIED","message":"Email not verified"}`))
	}))
	defer srv.Close()

	_, err := signInEmail(t.Context(), srv.Client(), srv.URL, "a@b.test", "hash")
	if !isEmailNotVerified(err) {
		t.Fatalf("err = %v, want an unverified-email refusal", err)
	}
}

// /update-user authenticates by session cookie and answers a bearer token with
// 401 — the same rule /token follows. Sending the bearer instead was a real bug
// (every avatar upload failed "Unauthorized"), so pin the credential the request
// actually carries rather than trusting the endpoint to accept either.
func TestUpdateImageAuthenticatesWithCookie(t *testing.T) {
	var gotCookie, gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCookie = r.Header.Get("Cookie")
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	const cookie = "better-auth.session_token=abc.def"
	if err := updateImage(t.Context(), srv.Client(), srv.URL, cookie, "data:image/webp;base64,AA"); err != nil {
		t.Fatalf("updateImage: %v", err)
	}
	if gotCookie != cookie {
		t.Fatalf("Cookie = %q, want %q", gotCookie, cookie)
	}
	if gotAuth != "" {
		t.Fatalf("Authorization = %q, want no bearer header", gotAuth)
	}
	var sent map[string]string
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
		t.Fatalf("decode body %q: %v", gotBody, err)
	}
	if sent["image"] != "data:image/webp;base64,AA" {
		t.Fatalf("image = %q, want the picture", sent["image"])
	}
	// Clearing must send an explicit empty image, not omit the key — an omitted
	// field is "no fields to update", which would leave the old avatar in place.
	if _, ok := sent["image"]; !ok {
		t.Fatal("expected the image key to always be present")
	}
}

// The emailed-code endpoints have no session yet, so they must send no
// credential at all rather than an empty Cookie header.
func TestPostJSONWithoutCookieSendsNoCredential(t *testing.T) {
	var hadCookie bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadCookie = r.Header["Cookie"]
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := postJSON(t.Context(), srv.Client(), srv.URL, "", map[string]string{"email": "a@b.test"}); err != nil {
		t.Fatalf("postJSON: %v", err)
	}
	if hadCookie {
		t.Fatal("expected no Cookie header when there is no session")
	}
}
