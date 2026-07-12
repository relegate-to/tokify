package neonsync

import (
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
)

func act(project string, start time.Time) models.Activity {
	end := start.Add(time.Hour)
	return models.Activity{Project: project, StartTime: start, EndTime: &end}
}

func TestFilterMatchesProjects(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	f := shareFilter{Projects: []string{"tokify", "ops"}}

	if !f.matches(act("tokify", now), now) {
		t.Fatal("entry in project list should match")
	}
	if f.matches(act("secret", now), now) {
		t.Fatal("entry outside project list should not match")
	}

	// Empty project list means any project matches.
	anyProject := shareFilter{}
	if !anyProject.matches(act("anything", now), now) {
		t.Fatal("empty project list should match any project")
	}
	if !anyProject.matches(act("", now), now) {
		t.Fatal("empty project list should match a project-less entry")
	}
}

func TestFilterMatchesSinceDays(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	f := shareFilter{SinceDays: 7}

	if !f.matches(act("p", now.AddDate(0, 0, -3)), now) {
		t.Fatal("entry within window should match")
	}
	if f.matches(act("p", now.AddDate(0, 0, -10)), now) {
		t.Fatal("entry older than window should not match")
	}
	// Boundary: exactly N days ago is still inside (Before is strict).
	if !f.matches(act("p", now.AddDate(0, 0, -7)), now) {
		t.Fatal("entry exactly N days old should still match")
	}
}

func TestFilterMatchesProjectsAndSinceDaysANDed(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	f := shareFilter{Projects: []string{"tokify"}, SinceDays: 7}

	// Right project but too old.
	if f.matches(act("tokify", now.AddDate(0, 0, -30)), now) {
		t.Fatal("stale entry should fail even with matching project")
	}
	// Recent but wrong project.
	if f.matches(act("other", now), now) {
		t.Fatal("wrong project should fail even when recent")
	}
	// Both satisfied.
	if !f.matches(act("tokify", now), now) {
		t.Fatal("matching project + recent should match")
	}
}

func TestFilterValidUntil(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)

	// No window -> no upper bound.
	if u := (shareFilter{}).validUntil(act("p", now)); u != nil {
		t.Fatalf("zero window should give nil valid_until, got %v", u)
	}

	f := shareFilter{SinceDays: 7}
	a := act("p", now)
	u := f.validUntil(a)
	if u == nil {
		t.Fatal("windowed filter should give a valid_until")
	}
	want := now.AddDate(0, 0, 7)
	if !u.Equal(want) {
		t.Fatalf("valid_until = %v, want %v (start + window)", u, want)
	}
}

func TestFilterRoundTrip(t *testing.T) {
	f := shareFilter{Projects: []string{"a", "b"}, SinceDays: 14}
	raw, err := f.marshal()
	if err != nil {
		t.Fatal(err)
	}
	got, err := unmarshalFilter(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.SinceDays != f.SinceDays || len(got.Projects) != 2 || got.Projects[0] != "a" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}

	// Marshal is deterministic (fixed-field struct) so a re-wrap reproduces bytes.
	raw2, _ := f.marshal()
	if string(raw) != string(raw2) {
		t.Fatal("filter marshal not deterministic")
	}
}
