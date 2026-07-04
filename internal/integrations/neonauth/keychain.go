package neonauth

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
)

// keychainStore stores the opaque session token under the login keychain via
// the `security` CLI. Shelling out keeps us free of cgo and third-party deps;
// the CLI is part of every macOS install. Mirrors the Teams integration's
// store so both integrations behave identically around Keychain locking.
//
// The service name is fixed; the account name is a single fixed slot since we
// only ever hold one session at a time.
type keychainStore struct {
	service string
}

func newKeychainStore() *keychainStore {
	return &keychainStore{service: "Toki Neon Auth"}
}

func (k *keychainStore) Save(ctx context.Context, account, secret string) error {
	// `add-generic-password -U` updates if it exists, creates otherwise.
	cmd := exec.CommandContext(ctx,
		"security", "add-generic-password",
		"-a", account,
		"-s", k.service,
		"-w", secret,
		"-U",
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return wrapSecurityErr(err, stderr.String())
	}
	return nil
}

func (k *keychainStore) Load(ctx context.Context, account string) (string, error) {
	cmd := exec.CommandContext(ctx,
		"security", "find-generic-password",
		"-a", account,
		"-s", k.service,
		"-w",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// `security` exits 44 when the item isn't found; surface that as a
		// distinct sentinel so callers can treat "missing" (signed out) as
		// distinct from "Keychain locked".
		if strings.Contains(stderr.String(), "could not be found") {
			return "", errNotFound
		}
		return "", wrapSecurityErr(err, stderr.String())
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}

func (k *keychainStore) Delete(ctx context.Context, account string) error {
	cmd := exec.CommandContext(ctx,
		"security", "delete-generic-password",
		"-a", account,
		"-s", k.service,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if strings.Contains(stderr.String(), "could not be found") {
			return nil
		}
		return wrapSecurityErr(err, stderr.String())
	}
	return nil
}

var errNotFound = errors.New("keychain item not found")

func wrapSecurityErr(err error, stderr string) error {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		return err
	}
	return errors.New("security: " + msg)
}
