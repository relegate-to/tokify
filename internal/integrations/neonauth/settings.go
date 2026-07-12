package neonauth

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/go-faster/errors"
)

// Settings are the user-controlled preferences for the Neon Auth integration.
// Stored as JSON at ~/Library/Application Support/Tokify/neonauth.json so they
// don't pollute the upstream tock data file. The Auth URL is the single value
// Neon Auth (Better Auth) needs; find it in the Neon Console under
// Auth -> Configuration.
type Settings struct {
	AuthURL string `json:"auth_url"`
}

func defaultSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Wrap(err, "home dir")
	}
	return filepath.Join(home, "Library", "Application Support", "Tokify", "neonauth.json"), nil
}

func loadSettings(path string) (Settings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Settings{}, nil
		}
		return Settings{}, errors.Wrap(err, "read settings")
	}
	var s Settings
	if uerr := json.Unmarshal(data, &s); uerr != nil {
		return Settings{}, errors.Wrap(uerr, "unmarshal settings")
	}
	return s, nil
}

func saveSettings(path string, s Settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return errors.Wrap(err, "ensure settings dir")
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return errors.Wrap(err, "marshal settings")
	}
	if werr := os.WriteFile(path, data, 0o600); werr != nil {
		return errors.Wrap(werr, "write settings")
	}
	return nil
}
