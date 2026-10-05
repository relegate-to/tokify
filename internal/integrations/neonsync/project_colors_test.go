package neonsync

import "testing"

func TestMergeColorsKeepsNewestChoice(t *testing.T) {
	remote := map[string]ColorPref{
		"Client": {Color: "var(--project-color-1)", At: "2026-10-01T10:00:00Z"},
		"Ops":    {Color: "var(--project-color-2)", At: "2026-10-03T10:00:00Z"},
	}
	local := map[string]ColorPref{
		"Client": {Color: "var(--project-color-5)", At: "2026-10-02T09:00:00.5Z"},
		"Ops":    {Color: "", At: "2026-10-02T10:00:00Z"},
		"New":    {Color: "var(--project-color-7)", At: "2026-10-04T10:00:00Z"},
	}
	got := MergeColors(remote, local)
	want := map[string]ColorPref{
		"Client": local["Client"],
		"Ops":    remote["Ops"],
		"New":    local["New"],
	}
	if len(got) != len(want) {
		t.Fatalf("got %d colors, want %d", len(got), len(want))
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s = %+v, want %+v", name, got[name], w)
		}
	}
}

func TestMergeColorsPrefersTheFirstSetOnATie(t *testing.T) {
	a := map[string]ColorPref{"P": {Color: "a", At: "2026-10-01T10:00:00Z"}}
	b := map[string]ColorPref{"P": {Color: "b", At: "2026-10-01T10:00:00Z"}}
	if got := MergeColors(a, b)["P"].Color; got != "a" {
		t.Errorf("tie resolved to %q, want the first set's", got)
	}
}
