// Package netcheck provides a lightweight connectivity probe so the Teams and
// Neon Auth integrations can avoid firing network requests — or spawning the
// interactive sign-in helper — while the device is offline. Both integrations
// are optional decoration on top of local time tracking, so silently doing
// nothing offline is preferable to surfacing dial errors or popping sign-in
// windows the user can't complete.
package netcheck

import (
	"context"
	"errors"
	"net"
	"time"
)

// ErrOffline is returned by the integrations when a network operation is
// skipped because the device appears to be offline. The message is sentence-cased
// and punctuated because the desktop UI renders it verbatim, matching the
// frontend's own error copy.
//
//nolint:staticcheck // ST1005: user-facing display string, not a wrap-chain fragment.
var ErrOffline = errors.New("You appear to be offline. Check your connection and try again.")

// probeTimeout bounds the reachability check. Short enough not to add
// noticeable latency to a Start/Stop, long enough to tolerate a slow DNS
// resolver on a real connection.
const probeTimeout = 3 * time.Second

// Online reports whether host is reachable on the HTTPS port within a short
// timeout. It is a best-effort probe: a false result reliably means "no network
// / host unreachable" (DNS failure, no route), while a true result only means
// the TCP handshake succeeded — not that the eventual HTTPS request will. That
// asymmetry is exactly what callers want: skip work that would certainly fail
// offline, without falsely blocking work that might succeed.
func Online(ctx context.Context, host string) bool {
	if host == "" {
		return false
	}
	d := net.Dialer{Timeout: probeTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, "443"))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
