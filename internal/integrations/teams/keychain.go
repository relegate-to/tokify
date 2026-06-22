package teams

import (
	"bytes"
	"errors"
	"os/exec"
	"strings"
)

// keychainStore stores opaque token strings under the login keychain via the
// `security` CLI. Shelling out keeps us free of cgo and third-party deps; the
// CLI is part of every macOS install.
//
// The service name is fixed; the account name is the audience tag
// ("teams"/"skype"/"chatsvcagg") so each token has its own slot.
type keychainStore struct {
	service string
}

func newKeychainStore() *keychainStore {
	return &keychainStore{service: "Toki Teams Integration"}
}

func (k *keychainStore) Save(account, secret string) error {
	// `add-generic-password -U` updates if it exists, creates otherwise.
	cmd := exec.Command(
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

func (k *keychainStore) Load(account string) (string, error) {
	cmd := exec.Command(
		"security", "find-generic-password",
		"-a", account,
		"-s", k.service,
		"-w",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// `security` exits 44 when the item isn't found; we surface that as a
		// distinct sentinel so callers can treat "missing" differently from
		// "Keychain locked".
		if strings.Contains(stderr.String(), "could not be found") {
			return "", errNotFound
		}
		return "", wrapSecurityErr(err, stderr.String())
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}

func (k *keychainStore) Delete(account string) error {
	cmd := exec.Command(
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
