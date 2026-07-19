package projects

import (
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
