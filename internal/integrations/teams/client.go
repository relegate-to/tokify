package teams

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"time"

	"github.com/go-faster/errors"
)

// httpClient talks to the modern "Teams V2 web" presence endpoint at
// teams.cloud.microsoft (the old presence.teams.microsoft.com host returns
// 401 for new tokens). The path is regional — /ups/<region>/v1/... — and we
// can't easily discover the user's region from a static config, so we accept
// it as a constructor argument.
//
// Presence accepts a plain Azure AD Bearer token issued for the
// `https://presence.teams.microsoft.com` resource.
type httpClient struct {
	hc     *http.Client
	region string
}

func newHTTPClient() *httpClient {
	return &httpClient{
		hc:     &http.Client{Timeout: 15 * time.Second},
		region: "emea", // TODO: discover from token / tenant; "noam"/"emea"/"apac"
	}
}

// PublishNote sets the user's Teams status message. Message text is
// HTML-escaped and wrapped in <p>...</p> — Teams renders the field as
// rich-text and the official client always sends it that way.
//
// On 4xx the response body and key auth-diagnostic headers are included in
// the error so we can iterate on undocumented behavior without a packet
// capture.
func (c *httpClient) PublishNote(ctx context.Context, presenceToken, message string, expiry time.Time) error {
	if expiry.IsZero() {
		// Teams' sentinel for "never expires" (observed in V2 web client).
		expiry = time.Date(9999, 12, 30, 15, 0, 0, 0, time.UTC)
	}
	// Teams renders the field as rich text and the official client wraps
	// non-empty messages in <p>...</p>. An empty message is sent as bare ""
	// (no wrapping tags) to mean "clear the note".
	formatted := ""
	if message != "" {
		formatted = "<p>" + html.EscapeString(message) + "</p>"
	}
	body := map[string]any{
		"message": formatted,
		"expiry":  expiry.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return errors.Wrap(err, "marshal body")
	}
	url := fmt.Sprintf("https://teams.cloud.microsoft/ups/%s/v1/me/publishnote", c.region)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(buf))
	if err != nil {
		return errors.Wrap(err, "new request")
	}
	corr, _ := randomHex()
	req.Header.Set("Authorization", "Bearer "+presenceToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Behavioroverride", "redirectAs404")
	req.Header.Set("X-Ms-Client-Type", "cdlworker")
	req.Header.Set("X-Ms-Client-User-Agent", "Teams-V2-Web")
	req.Header.Set("X-Ms-Client-Version", "1415/26051416715")
	req.Header.Set("X-Ms-Correlation-Id", corr)

	resp, err := c.hc.Do(req)
	if err != nil {
		return errors.Wrap(err, "do request")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		wwwAuth := resp.Header.Get("WWW-Authenticate")
		msAuth := resp.Header.Get("X-Ms-Diagnostics")
		hint := ""
		if wwwAuth != "" {
			hint = " WWW-Authenticate=" + wwwAuth
		}
		if msAuth != "" {
			hint += " X-Ms-Diagnostics=" + msAuth
		}
		return errors.Errorf("publish note: HTTP %d:%s body=%q", resp.StatusCode, hint, string(respBody))
	}
	return nil
}

// ClearNote wipes the status message. Convenience wrapper.
func (c *httpClient) ClearNote(ctx context.Context, presenceToken string) error {
	return c.PublishNote(ctx, presenceToken, "", time.Time{})
}
