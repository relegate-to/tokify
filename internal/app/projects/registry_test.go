package projects

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenMissingFileIsEmpty(t *testing.T) {
	r, err := Open(filepath.Join(t.TempDir(), "projects.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := r.List(); len(got) != 0 {
		t.Fatalf("want empty registry, got %v", got)
	}
}

func TestCreateIsIdempotentAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "projects.json")
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if _, err = r.Create("  Golden Gate  "); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err = r.Create("Golden Gate"); err != nil {
		t.Fatalf("Create (idempotent): %v", err)
	}
	if got := r.List(); len(got) != 1 || got[0].Name != "Golden Gate" {
		t.Fatalf("want single trimmed project, got %v", got)
	}

	if _, err = r.Create(""); err == nil {
		t.Fatal("Create(\"\") should error")
	}

	reloaded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reloaded.List(); len(got) != 1 || got[0].Name != "Golden Gate" {
		t.Fatalf("want persisted project after reload, got %v", got)
	}
}

func TestEnsureDedupsAndKeepsOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "projects.json")
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err = r.Ensure("alpha", "beta", "alpha", "", "  ", "gamma"); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	got := r.List()
	want := []string{"alpha", "beta", "gamma"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("position %d: want %q, got %q", i, name, got[i].Name)
		}
	}

	// A create keeps the audience binding through a subsequent Ensure that
	// re-sees the same name from the log.
	if err = r.Ensure("alpha"); err != nil {
		t.Fatalf("Ensure re-see: %v", err)
	}
	if got = r.List(); len(got) != 3 {
		t.Fatalf("Ensure should not duplicate, got %v", got)
	}
}

func TestRenameCarriesAudienceAndPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects.json")
	seed := `{"projects":[{"name":"Old","audience_id":"aud123"}]}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	p, err := r.Rename("  Old  ", "  New  ")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if p.Name != "New" || p.AudienceID != "aud123" {
		t.Fatalf("want carried audience under trimmed name, got %+v", p)
	}
	if got := r.List(); len(got) != 1 || got[0].Name != "New" {
		t.Fatalf("want single renamed project, got %v", got)
	}

	reloaded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reloaded.List(); len(got) != 1 || got[0].Name != "New" || got[0].AudienceID != "aud123" {
		t.Fatalf("want persisted rename with audience, got %v", got)
	}
}

func TestRenameUnregisteredEnsuresNew(t *testing.T) {
	r, err := Open(filepath.Join(t.TempDir(), "projects.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Renaming a name that was never registered (its rows lived only in the log)
	// simply lands the new name — this is what keeps a retried rename idempotent.
	p, err := r.Rename("ghost", "Real")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if p.Name != "Real" {
		t.Fatalf("want ensured new name, got %+v", p)
	}
	if got := r.List(); len(got) != 1 || got[0].Name != "Real" {
		t.Fatalf("want single ensured project, got %v", got)
	}

	if _, err = r.Rename("Real", ""); err == nil {
		t.Fatal("Rename to empty should error")
	}
}

func TestDeleteRemovesAndPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects.json")
	seed := `{"projects":[{"name":"Keep","color":"var(--project-color-1)"},{"name":"Drop","audience_id":"aud9"}]}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	removed, ok, err := r.Delete("  Drop  ")
	if err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if !ok || removed.AudienceID != "aud9" {
		t.Fatalf("want removed Drop with audience, got %+v ok=%v", removed, ok)
	}
	if got := r.List(); len(got) != 1 || got[0].Name != "Keep" {
		t.Fatalf("want only Keep remaining, got %v", got)
	}

	// Deleting an unknown name is a no-op, not an error.
	if _, ok, err = r.Delete("Ghost"); err != nil || ok {
		t.Fatalf("Delete unknown: ok=%v err=%v", ok, err)
	}

	reloaded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reloaded.List(); len(got) != 1 || got[0].Name != "Keep" || got[0].Color != "var(--project-color-1)" {
		t.Fatalf("want persisted single Keep with color, got %v", got)
	}
}

func TestSetColorPersistsAndRenameCarriesIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "projects.json")
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// SetColor registers the project if it was only implicit in the log.
	if _, err = r.SetColor("Aurora", "var(--project-color-3)"); err != nil {
		t.Fatalf("SetColor: %v", err)
	}
	if got := r.List(); len(got) != 1 || got[0].Color != "var(--project-color-3)" {
		t.Fatalf("want stored color, got %v", got)
	}

	// A rename carries the color to the new name.
	p, err := r.Rename("Aurora", "Borealis")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if p.Color != "var(--project-color-3)" {
		t.Fatalf("want color carried through rename, got %+v", p)
	}

	// Clearing the color persists too.
	if _, err = r.SetColor("Borealis", ""); err != nil {
		t.Fatalf("SetColor clear: %v", err)
	}
	reloaded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reloaded.List(); len(got) != 1 || got[0].Name != "Borealis" || got[0].Color != "" {
		t.Fatalf("want cleared color persisted, got %v", got)
	}
}
