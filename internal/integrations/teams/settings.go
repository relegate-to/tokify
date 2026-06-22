package teams

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/go-faster/errors"
)

// Settings are the user-controlled preferences for the Teams integration.
// Stored as JSON at ~/Library/Application Support/Toki/teams.json so they
// don't pollute the upstream tock data file.
type Settings struct {
	Enabled         bool     `json:"enabled"`
	TrackedProjects []string `json:"tracked_projects"`
}

func defaultSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Wrap(err, "home dir")
	}
	return filepath.Join(home, "Library", "Application Support", "Toki", "teams.json"), nil
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
	sort.Strings(s.TrackedProjects)
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
