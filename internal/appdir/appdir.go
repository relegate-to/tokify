// Package appdir centralizes where Tokify keeps its per-user state and how that
// state is namespaced for local multi-user testing.
//
// Every Tokify store (neonauth/neonsync settings, pins, tombstones, the team and
// project registries) and every Keychain slot is normally a single fixed
// location, because a real install only ever hosts one signed-in user. That makes
// it impossible to run two users side by side on one machine: a second sign-in
// overwrites the first user's files and Keychain items.
//
// Setting TOKIFY_PROFILE=<name> namespaces all of it:
//   - the config dir becomes  ~/Library/Application Support/Tokify-<name>/
//   - Keychain services gain a " (<name>)" suffix, so DEK/identity slots don't
//     collide (the macOS login keychain is shared across $HOME, so path
//     isolation alone is not enough — the service name must differ too)
//   - the activity log defaults to ~/.tock-<name>.txt
//
// An empty/unset profile yields the historical paths and service names verbatim,
// so existing installs are untouched. This is a dev affordance, not a
// multi-account feature: it only reads an env var.
package appdir

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/go-faster/errors"
)

// Profile returns the active TOKIFY_PROFILE, trimmed. Empty means the default
// (unprofiled) install.
func Profile() string {
	return strings.TrimSpace(os.Getenv("TOKIFY_PROFILE"))
}

// Dir returns the Tokify config directory, suffixed with the active profile.
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Wrap(err, "home dir")
	}
	name := "Tokify"
	if p := Profile(); p != "" {
		name += "-" + p
	}
	return filepath.Join(home, "Library", "Application Support", name), nil
}

// Path joins one or more elements onto the profile-aware config dir. Callers use
// it in place of a hardcoded ~/Library/Application Support/Tokify/<file> join.
func Path(elem ...string) (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{dir}, elem...)...), nil
}

// KeychainService suffixes a base Keychain service name with the active profile,
// so per-user secrets (DEK, identity keys, session token) don't collide in the
// shared login keychain. Returns base unchanged when no profile is set.
func KeychainService(base string) string {
	if p := Profile(); p != "" {
		return base + " (" + p + ")"
	}
	return base
}

// LogPath is the profile-namespaced activity log (~/.tock-<name>.txt), or ""
// when no profile is set so the caller falls back to the upstream default
// (~/.tock.txt, or whatever TOCK_FILE / config specifies).
func LogPath() string {
	p := Profile()
	if p == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".tock-"+p+".txt")
}
