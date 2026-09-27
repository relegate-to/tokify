// Package history keeps the desktop session's undo and redo stacks.
package history

import (
	"context"
	"sync"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/core/ports"
)

const defaultLimit = 100

type Entry struct {
	Label   string
	Changes []models.ActivityChange
}

type Status struct {
	CanUndo   bool   `json:"can_undo"`
	CanRedo   bool   `json:"can_redo"`
	UndoLabel string `json:"undo_label,omitempty"`
	RedoLabel string `json:"redo_label,omitempty"`
}

type Outcome struct {
	Label   string
	Changes []models.ActivityChange
	Status  Status
}

// Journal is intentionally session-scoped. Activity rows remain durable in
// SQLite, while the command history disappears on restart rather than replaying
// an old action against a database that may have changed in another process.
type Journal struct {
	repo  ports.ActivityChangeRepository
	limit int

	mu   sync.Mutex
	undo []Entry
	redo []Entry
}

func New(repo ports.ActivityChangeRepository, limit int) *Journal {
	if limit <= 0 {
		limit = defaultLimit
	}
	return &Journal{repo: repo, limit: limit}
}

// Record adds a completed mutation to the undo stack. Calling it for a new
// mutation clears redo, matching normal desktop undo semantics.
func (j *Journal) Record(label string, changes ...models.ActivityChange) {
	if len(changes) == 0 {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.undo = append(j.undo, Entry{Label: label, Changes: cloneChanges(changes)})
	if extra := len(j.undo) - j.limit; extra > 0 {
		copy(j.undo, j.undo[extra:])
		j.undo = j.undo[:j.limit]
	}
	j.redo = nil
}

func (j *Journal) Status() Status {
	j.mu.Lock()
	defer j.mu.Unlock()
	return status(j.undo, j.redo)
}

func (j *Journal) Undo(ctx context.Context) (Outcome, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.undo) == 0 {
		return Outcome{Status: status(j.undo, j.redo)}, nil
	}
	entry := j.undo[len(j.undo)-1]
	applied := reverse(entry.Changes)
	if err := j.repo.ApplyChanges(ctx, applied); err != nil {
		return Outcome{Status: status(j.undo, j.redo)}, err
	}
	j.undo = j.undo[:len(j.undo)-1]
	j.redo = append(j.redo, entry)
	return Outcome{Label: entry.Label, Changes: applied, Status: status(j.undo, j.redo)}, nil
}

func (j *Journal) Redo(ctx context.Context) (Outcome, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.redo) == 0 {
		return Outcome{Status: status(j.undo, j.redo)}, nil
	}
	entry := j.redo[len(j.redo)-1]
	applied := cloneChanges(entry.Changes)
	if err := j.repo.ApplyChanges(ctx, applied); err != nil {
		return Outcome{Status: status(j.undo, j.redo)}, err
	}
	j.redo = j.redo[:len(j.redo)-1]
	j.undo = append(j.undo, entry)
	return Outcome{Label: entry.Label, Changes: applied, Status: status(j.undo, j.redo)}, nil
}

func (j *Journal) Clear() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.undo = nil
	j.redo = nil
}

func Created(activity models.Activity) models.ActivityChange {
	a := cloneActivity(activity)
	return models.ActivityChange{After: &a}
}

func Deleted(activity models.Activity) models.ActivityChange {
	a := cloneActivity(activity)
	return models.ActivityChange{Before: &a}
}

// Replaced returns one change for an in-place edit, or a delete/create pair
// when an edit moves the activity to a different start time.
func Replaced(before, after models.Activity) []models.ActivityChange {
	if before.StartTime.Equal(after.StartTime) {
		b, a := cloneActivity(before), cloneActivity(after)
		return []models.ActivityChange{{Before: &b, After: &a}}
	}
	return []models.ActivityChange{Deleted(before), Created(after)}
}

func reverse(changes []models.ActivityChange) []models.ActivityChange {
	out := make([]models.ActivityChange, len(changes))
	for i, change := range changes {
		out[i] = models.ActivityChange{
			Before: cloneActivityPtr(change.After),
			After:  cloneActivityPtr(change.Before),
		}
	}
	return out
}

func cloneChanges(changes []models.ActivityChange) []models.ActivityChange {
	out := make([]models.ActivityChange, len(changes))
	for i, change := range changes {
		out[i] = models.ActivityChange{
			Before: cloneActivityPtr(change.Before),
			After:  cloneActivityPtr(change.After),
		}
	}
	return out
}

func cloneActivityPtr(activity *models.Activity) *models.Activity {
	if activity == nil {
		return nil
	}
	cloned := cloneActivity(*activity)
	return &cloned
}

func cloneActivity(activity models.Activity) models.Activity {
	if activity.EndTime != nil {
		end := *activity.EndTime
		activity.EndTime = &end
	}
	if activity.Tags != nil {
		activity.Tags = append([]string{}, activity.Tags...)
	}
	return activity
}

func status(undo, redo []Entry) Status {
	s := Status{CanUndo: len(undo) > 0, CanRedo: len(redo) > 0}
	if s.CanUndo {
		s.UndoLabel = undo[len(undo)-1].Label
	}
	if s.CanRedo {
		s.RedoLabel = redo[len(redo)-1].Label
	}
	return s
}
