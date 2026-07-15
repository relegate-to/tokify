package appdir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProfileNamespacing(t *testing.T) {
	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		t.Fatalf("home dir: %v", homeErr)
	}

	t.Run("unset yields default paths", func(t *testing.T) {
		t.Setenv("TOKIFY_PROFILE", "")
		dir, err := Dir()
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(home, "Library", "Application Support", "Tokify")
		if dir != want {
			t.Errorf("dir = %q, want %q", dir, want)
		}
		if got := KeychainService("Tokify Neon Sync"); got != "Tokify Neon Sync" {
			t.Errorf("service = %q, want unchanged", got)
		}
		if got := LogPath(); got != "" {
			t.Errorf("log = %q, want empty", got)
		}
	})

	t.Run("set namespaces dir, service, and log", func(t *testing.T) {
		t.Setenv("TOKIFY_PROFILE", "alice")
		dir, err := Dir()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(dir, "Tokify-alice") {
			t.Errorf("dir = %q, want suffix Tokify-alice", dir)
		}
		p, err := Path("neonsync.json")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(p, filepath.Join("Tokify-alice", "neonsync.json")) {
			t.Errorf("path = %q, want profile-scoped", p)
		}
		if got := KeychainService("Tokify Neon Sync"); got != "Tokify Neon Sync (alice)" {
			t.Errorf("service = %q, want suffixed", got)
		}
		if got, want := LogPath(), filepath.Join(home, ".tock-alice.txt"); got != want {
			t.Errorf("log = %q, want %q", got, want)
		}
	})

	t.Run("profile is trimmed", func(t *testing.T) {
		t.Setenv("TOKIFY_PROFILE", "  bob  ")
		if got := Profile(); got != "bob" {
			t.Errorf("profile = %q, want bob", got)
		}
	})
}
