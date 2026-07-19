package neonsync

import (
	"path/filepath"
	"testing"
)

func TestLoadSettingsDefaultsSyncToEnabled(t *testing.T) {
	settings, err := loadSettings(filepath.Join(t.TempDir(), "neonsync.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled {
		t.Fatal("sync should be enabled when settings do not exist")
	}
}

func TestLoadSettingsPreservesDisabledSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neonsync.json")
	if err := saveSettings(path, Settings{Enabled: false}); err != nil {
		t.Fatal(err)
	}

	settings, err := loadSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Enabled {
		t.Fatal("explicitly disabled sync should remain disabled")
	}
}
