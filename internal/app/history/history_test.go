package history

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/kriuchkov/tock/internal/core/models"
)

type changeStore struct {
	applied [][]models.ActivityChange
	err     error
}

func (s *changeStore) ApplyChanges(_ context.Context, changes []models.ActivityChange) error {
	if s.err != nil {
		return s.err
	}
	s.applied = append(s.applied, cloneChanges(changes))
	return nil
}

func TestJournalUndoRedo(t *testing.T) {
	store := &changeStore{}
	j := New(store, 10)
	start := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)
	activity := models.Activity{Description: "Write tests", Project: "Tokify", StartTime: start}

	j.Record("Create activity", Created(activity))
	require.Equal(t, Status{CanUndo: true, UndoLabel: "Create activity"}, j.Status())

	undone, err := j.Undo(t.Context())
	require.NoError(t, err)
	require.Len(t, undone.Changes, 1)
	assert.Equal(t, &activity, undone.Changes[0].Before)
	assert.Nil(t, undone.Changes[0].After)
	assert.Equal(t, Status{CanRedo: true, RedoLabel: "Create activity"}, undone.Status)

	redone, err := j.Redo(t.Context())
	require.NoError(t, err)
	require.Len(t, redone.Changes, 1)
	assert.Nil(t, redone.Changes[0].Before)
	assert.Equal(t, &activity, redone.Changes[0].After)
	assert.Equal(t, Status{CanUndo: true, UndoLabel: "Create activity"}, redone.Status)
}

func TestJournalFailedUndoKeepsHistory(t *testing.T) {
	store := &changeStore{err: errors.New("conflict")}
	j := New(store, 10)
	j.Record("Delete activity", Deleted(models.Activity{StartTime: time.Now()}))

	_, err := j.Undo(t.Context())
	require.EqualError(t, err, "conflict")
	assert.True(t, j.Status().CanUndo)
	assert.False(t, j.Status().CanRedo)
}

func TestJournalNewMutationClearsRedoAndHonorsLimit(t *testing.T) {
	store := &changeStore{}
	j := New(store, 2)
	for i, label := range []string{"one", "two", "three"} {
		j.Record(label, Created(models.Activity{StartTime: time.Unix(int64(i), 0)}))
	}

	_, err := j.Undo(t.Context())
	require.NoError(t, err)
	assert.True(t, j.Status().CanRedo)
	j.Record("replacement", Created(models.Activity{StartTime: time.Unix(10, 0)}))
	assert.False(t, j.Status().CanRedo)

	first, err := j.Undo(t.Context())
	require.NoError(t, err)
	second, err := j.Undo(t.Context())
	require.NoError(t, err)
	third, err := j.Undo(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "replacement", first.Label)
	assert.Equal(t, "two", second.Label)
	assert.Empty(t, third.Label)
}

func TestReplacedUsesDeleteAndCreateWhenStartMoves(t *testing.T) {
	before := models.Activity{Description: "Before", StartTime: time.Unix(1, 0)}
	after := models.Activity{Description: "After", StartTime: time.Unix(2, 0)}

	changes := Replaced(before, after)
	require.Len(t, changes, 2)
	assert.Equal(t, &before, changes[0].Before)
	assert.Nil(t, changes[0].After)
	assert.Nil(t, changes[1].Before)
	assert.Equal(t, &after, changes[1].After)
}

func TestCreatedPreservesEmptyTagRepresentation(t *testing.T) {
	activity := models.Activity{StartTime: time.Unix(1, 0), Tags: []string{}}

	change := Created(activity)
	require.NotNil(t, change.After.Tags)
	assert.Empty(t, change.After.Tags)
}
