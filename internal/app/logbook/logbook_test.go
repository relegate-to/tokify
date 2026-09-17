package logbook

import (
	"path/filepath"
	"testing"
	"time"

	_ "github.com/doug-martin/goqu/v9/dialect/sqlite3" // register the goqu sqlite3 dialect
	_ "github.com/mattn/go-sqlite3"                    // register the sqlite3 database driver

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/kriuchkov/tock/internal/app/runtime"
	"github.com/kriuchkov/tock/internal/core/models"
)

type recordedDeletions []models.Activity

func (r *recordedDeletions) RecordDeletion(act models.Activity) error {
	*r = append(*r, act)
	return nil
}

func newTestLogbook(t *testing.T, registered ...string) (*Logbook, *recordedDeletions) {
	t.Helper()
	rt, err := runtime.Load(t.Context(), filepath.Join(t.TempDir(), "tock.db"))
	require.NoError(t, err)
	deletions := &recordedDeletions{}
	lb := New(rt.ActivityRepo, deletions, func() []string { return registered })
	lb.now = func() time.Time { return time.Date(2026, 9, 16, 18, 0, 0, 0, time.Local) }
	return lb, deletions
}

func mustAdd(t *testing.T, lb *Logbook, req AddRequest) {
	t.Helper()
	_, err := lb.Add(t.Context(), req)
	require.NoError(t, err)
}

func at(hour, minute int) time.Time {
	return time.Date(2026, 9, 16, hour, minute, 0, 0, time.Local)
}

func TestAddAndList(t *testing.T) {
	lb, _ := newTestLogbook(t)

	added, err := lb.Add(t.Context(), AddRequest{
		Description: " Technical Meeting ",
		Project:     "Imaged Reality",
		Start:       at(10, 30),
		End:         at(11, 18),
	})
	require.NoError(t, err)
	assert.Equal(t, "Technical Meeting", added.Description)
	assert.Equal(t, 48, added.Minutes)
	assert.Equal(t, at(10, 30).Format(time.RFC3339), added.Start)

	from, to, err := ParseRange("2026-09-16", "2026-09-16")
	require.NoError(t, err)
	entries, err := lb.List(t.Context(), from, to, "")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, added, entries[0])

	entries, err = lb.List(t.Context(), from, to, "Other")
	require.NoError(t, err)
	assert.Empty(t, entries)
}

func TestAddRejectsOverlap(t *testing.T) {
	lb, _ := newTestLogbook(t)
	_, err := lb.Add(t.Context(), AddRequest{Description: "First", Project: "P", Start: at(10, 0), End: at(11, 0)})
	require.NoError(t, err)

	for name, req := range map[string]AddRequest{
		"same start": {Description: "Dup", Start: at(10, 0), End: at(10, 30)},
		"partial":    {Description: "Late", Start: at(10, 45), End: at(11, 30)},
		"encloses":   {Description: "Wide", Start: at(9, 0), End: at(12, 0)},
	} {
		t.Run(name, func(t *testing.T) {
			_, addErr := lb.Add(t.Context(), req)
			var overlap *OverlapError
			require.ErrorAs(t, addErr, &overlap)
			assert.Equal(t, "First", overlap.Conflicts[0].Description)
		})
	}

	_, err = lb.Add(t.Context(), AddRequest{Description: "Adjacent", Start: at(11, 0), End: at(11, 30)})
	require.NoError(t, err)
}

func TestAddRejectsOverlapWithRunning(t *testing.T) {
	lb, _ := newTestLogbook(t)
	err := lb.repo.Save(t.Context(), models.Activity{Description: "Running", StartTime: at(15, 0)})
	require.NoError(t, err)

	_, err = lb.Add(t.Context(), AddRequest{Description: "Backfill", Start: at(16, 0), End: at(17, 0)})
	var overlap *OverlapError
	require.ErrorAs(t, err, &overlap)
	assert.True(t, overlap.Conflicts[0].Running)
	require.ErrorContains(t, err, "now (running)")
}

func TestAddValidates(t *testing.T) {
	lb, _ := newTestLogbook(t)

	_, err := lb.Add(t.Context(), AddRequest{Start: at(9, 0), End: at(10, 0)})
	require.ErrorContains(t, err, "description")

	_, err = lb.Add(t.Context(), AddRequest{Description: "x", Start: at(10, 0), End: at(10, 0)})
	require.ErrorContains(t, err, "end must be after start")

	_, err = lb.Add(t.Context(), AddRequest{Description: "x", Start: at(17, 0), End: at(19, 0)})
	require.ErrorContains(t, err, "future")
}

func TestProjectsMostRecentFirst(t *testing.T) {
	lb, _ := newTestLogbook(t, "Registered", "B")
	for _, req := range []AddRequest{
		{Description: "a", Project: "A", Start: at(8, 0), End: at(9, 0)},
		{Description: "b", Project: "B", Start: at(9, 0), End: at(10, 0)},
		{Description: "a", Project: "A", Start: at(10, 0), End: at(11, 0)},
	} {
		_, err := lb.Add(t.Context(), req)
		require.NoError(t, err)
	}

	names, err := lb.Projects(t.Context())
	require.NoError(t, err)
	assert.Equal(t, []string{"A", "B", "Registered"}, names)
}

func TestParseTime(t *testing.T) {
	want := at(14, 5)
	for _, in := range []string{"2026-09-16 14:05", "2026-09-16T14:05", "2026-09-16 14:05:00", want.Format(time.RFC3339)} {
		got, err := ParseTime(in)
		require.NoError(t, err, in)
		assert.True(t, want.Equal(got), in)
	}

	_, err := ParseTime("yesterday")
	require.Error(t, err)
}

func TestUpdateEditsInPlaceAndRecordsOriginal(t *testing.T) {
	lb, deletions := newTestLogbook(t)
	mustAdd(t, lb, AddRequest{Description: "Meeting", Project: "P", Start: at(10, 0), End: at(11, 0)})

	updated, err := lb.Update(t.Context(), at(10, 0), UpdateRequest{
		Description: new("Technical meeting"),
		End:         new(at(10, 45)),
		Notes:       new("roadmap"),
	})
	require.NoError(t, err)
	assert.Equal(t, "Technical meeting", updated.Description)
	assert.Equal(t, "P", updated.Project)
	assert.Equal(t, 45, updated.Minutes)
	assert.Equal(t, "roadmap", updated.Notes)

	entries, err := lb.List(t.Context(), at(0, 0), at(18, 0), "")
	require.NoError(t, err)
	assert.Equal(t, []Entry{updated}, entries)

	require.Len(t, *deletions, 1)
	assert.Equal(t, "Meeting", (*deletions)[0].Description)
}

func TestUpdateMovesStart(t *testing.T) {
	lb, _ := newTestLogbook(t)
	mustAdd(t, lb, AddRequest{Description: "Work", Start: at(10, 0), End: at(11, 0)})

	moved, err := lb.Update(t.Context(), at(10, 0), UpdateRequest{Start: new(at(9, 30))})
	require.NoError(t, err)
	assert.Equal(t, 90, moved.Minutes)

	entries, err := lb.List(t.Context(), at(0, 0), at(18, 0), "")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, at(9, 30).Format(time.RFC3339), entries[0].Start)
}

func TestUpdateRejectsOverlapWithOthersOnly(t *testing.T) {
	lb, deletions := newTestLogbook(t)
	mustAdd(t, lb, AddRequest{Description: "First", Start: at(10, 0), End: at(11, 0)})
	mustAdd(t, lb, AddRequest{Description: "Second", Start: at(11, 0), End: at(12, 0)})

	_, err := lb.Update(t.Context(), at(10, 0), UpdateRequest{End: new(at(11, 30))})
	var overlap *OverlapError
	require.ErrorAs(t, err, &overlap)
	require.Len(t, overlap.Conflicts, 1)
	assert.Equal(t, "Second", overlap.Conflicts[0].Description)
	assert.Empty(t, *deletions)

	_, err = lb.Update(t.Context(), at(10, 0), UpdateRequest{Start: new(at(10, 15))})
	require.NoError(t, err)
}

func TestUpdateRunningEntry(t *testing.T) {
	lb, _ := newTestLogbook(t)
	// Entries started live in the app carry sub-second starts.
	started := at(15, 0).Add(123 * time.Millisecond)
	require.NoError(t, lb.repo.Save(t.Context(), models.Activity{Description: "Running", StartTime: started}))

	renamed, err := lb.Update(t.Context(), at(15, 0), UpdateRequest{Project: new("Tokify")})
	require.NoError(t, err)
	assert.True(t, renamed.Running)
	assert.Equal(t, "Tokify", renamed.Project)

	stopped, err := lb.Update(t.Context(), at(15, 0), UpdateRequest{End: new(at(16, 0))})
	require.NoError(t, err)
	assert.False(t, stopped.Running)
	assert.Equal(t, 60, stopped.Minutes)

	_, err = lb.Update(t.Context(), at(15, 0), UpdateRequest{End: new(at(19, 0))})
	require.ErrorContains(t, err, "future")
}

func TestDelete(t *testing.T) {
	lb, deletions := newTestLogbook(t)
	mustAdd(t, lb, AddRequest{Description: "Oops", Project: "P", Start: at(10, 0), End: at(11, 0)})

	_, err := lb.Delete(t.Context(), at(10, 1))
	require.ErrorContains(t, err, "no entry starts at")

	deleted, err := lb.Delete(t.Context(), at(10, 0))
	require.NoError(t, err)
	assert.Equal(t, "Oops", deleted.Description)
	require.Len(t, *deletions, 1)

	entries, err := lb.List(t.Context(), at(0, 0), at(18, 0), "")
	require.NoError(t, err)
	assert.Empty(t, entries)
}
