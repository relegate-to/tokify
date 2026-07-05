package neonsync

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/go-faster/errors"
)

// Settings are the user-controlled preferences for the Neon sync integration.
// Stored as JSON at ~/Library/Application Support/Toki/neonsync.json, alongside
// the neonauth settings, so they don't pollute the upstream tock data file.
//
// DataURL is the Neon Data API (PostgREST) base URL; find it in the Neon
// Console under the Data API section. Enabled is the master switch the Account
// panel toggles — turning it off leaves the DEK and any synced rows in place.
type Settings struct {
	DataURL string `json:"data_url"`
	Enabled bool   `json:"enabled"`

	// LastSync (RFC3339) and EntryCount are sync bookkeeping, not preferences,
	// but they live in the same file so Status can render "last synced" without
	// a network round-trip.
	LastSync   string `json:"last_sync,omitempty"`
	EntryCount int    `json:"entry_count,omitempty"`
}

func defaultSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Wrap(err, "home dir")
	}
	return filepath.Join(home, "Library", "Application Support", "Toki", "neonsync.json"), nil
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
