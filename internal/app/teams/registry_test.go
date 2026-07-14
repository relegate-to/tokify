package teams

import (
	"path/filepath"
	"testing"
)

func TestOpenMissingFileIsEmpty(t *testing.T) {
	r, err := Open(filepath.Join(t.TempDir(), "teams.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := r.List(); len(got) != 0 {
		t.Fatalf("want empty registry, got %v", got)
	}
}

func TestSetNameUpsertsAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "teams.json")
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if _, err = r.SetName("aud-1", "  Design crew  "); err != nil {
		t.Fatalf("SetName: %v", err)
	}
	if got := r.Name("aud-1"); got != "Design crew" {
		t.Fatalf("want trimmed name, got %q", got)
	}

	// Re-setting the same audience renames in place rather than duplicating.
	if _, err = r.SetName("aud-1", "Design team"); err != nil {
		t.Fatalf("SetName rename: %v", err)
	}
	if got := r.List(); len(got) != 1 || got[0].Name != "Design team" {
		t.Fatalf("want single renamed team, got %v", got)
	}

	if _, err = r.SetName("", "x"); err == nil {
		t.Fatal("SetName with empty audience id should error")
	}
	if _, err = r.SetName("aud-2", ""); err == nil {
		t.Fatal("SetName with empty name should error")
	}

	reloaded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reloaded.Name("aud-1"); got != "Design team" {
		t.Fatalf("want persisted name after reload, got %q", got)
	}
}

func TestRemoveKeepsOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "teams.json")
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if _, err = r.SetName(id, "name-"+id); err != nil {
			t.Fatalf("SetName %s: %v", id, err)
		}
	}

	if err = r.Remove("b"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	got := r.List()
	want := []string{"a", "c"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i, id := range want {
		if got[i].AudienceID != id {
			t.Fatalf("position %d: want %q, got %q", i, id, got[i].AudienceID)
		}
	}

	// A later SetName still lands correctly after the reindex.
	if _, err = r.SetName("c", "renamed-c"); err != nil {
		t.Fatalf("SetName after remove: %v", err)
	}
	if got := r.Name("c"); got != "renamed-c" {
		t.Fatalf("want renamed-c, got %q", got)
	}

	if err = r.Remove("missing"); err != nil {
		t.Fatalf("Remove missing should be a no-op, got %v", err)
	}
}
