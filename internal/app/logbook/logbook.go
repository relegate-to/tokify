// Package logbook is the agent-facing view of the activity log: read entries
// for a range, list known projects, and add, edit, or delete entries. It exists
// so tools outside the desktop app (the MCP server) share one set of rules for
// time parsing and overlap checks instead of writing SQL against ~/.tock.db.
//
// Entries are identified by their start time, which the store keys rows on.
package logbook

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/core/ports"
)

// Entry is an activity rendered for agents: local times with offsets and a
// whole-minute duration, so nothing has to reason about UTC storage.
type Entry struct {
	Start       string `json:"start"             jsonschema:"start time, RFC 3339 in local time; also identifies the entry"`
	End         string `json:"end,omitempty"     jsonschema:"end time, RFC 3339 in local time; empty while running"`
	Minutes     int    `json:"minutes"           jsonschema:"duration rounded to whole minutes (up to now if running)"`
	Running     bool   `json:"running,omitempty" jsonschema:"true if the activity is still being tracked"`
	Project     string `json:"project"           jsonschema:"project name"`
	Description string `json:"description"       jsonschema:"what was worked on"`
	Notes       string `json:"notes,omitempty"   jsonschema:"free-form notes"`
}

type AddRequest struct {
	Description string
	Project     string
	Start       time.Time
	End         time.Time
	Notes       string
}

// UpdateRequest changes the fields that are non-nil and leaves the rest.
type UpdateRequest struct {
	Description *string
	Project     *string
	Start       *time.Time
	End         *time.Time
	Notes       *string
}

// DeletionRecorder tombstones an entry that no longer exists in its original
// form, so sync removes the cloud copy instead of pulling it back down.
type DeletionRecorder interface {
	RecordDeletion(activity models.Activity) error
}

// OverlapError reports the existing entries a change would collide with.
type OverlapError struct {
	Conflicts []Entry
}

func (e *OverlapError) Error() string {
	parts := make([]string, 0, len(e.Conflicts))
	for _, c := range e.Conflicts {
		end := c.End
		if c.Running {
			end = "now (running)"
		}
		parts = append(parts, fmt.Sprintf("%s to %s %q (%s)", c.Start, end, c.Description, c.Project))
	}
	return "overlaps existing entries: " + strings.Join(parts, "; ")
}

type Logbook struct {
	repo       ports.ActivityRepository
	deletions  DeletionRecorder
	registered func() []string
	now        func() time.Time
}

// New builds a Logbook. registered, when non-nil, supplies project names that
// exist in the project registry but may have no tracked time yet.
func New(repo ports.ActivityRepository, deletions DeletionRecorder, registered func() []string) *Logbook {
	return &Logbook{repo: repo, deletions: deletions, registered: registered, now: time.Now}
}

// List returns entries overlapping [from, to), oldest first.
func (l *Logbook) List(ctx context.Context, from, to time.Time, project string) ([]Entry, error) {
	if !to.After(from) {
		return nil, errors.New("to must be after from")
	}
	filter := models.ActivityFilter{FromDate: &from, ToDate: &to}
	if project = strings.TrimSpace(project); project != "" {
		filter.Project = &project
	}
	acts, err := l.repo.Find(ctx, filter)
	if err != nil {
		return nil, errors.Wrap(err, "list activities")
	}
	entries := make([]Entry, 0, len(acts))
	for _, act := range acts {
		entries = append(entries, l.entry(act))
	}
	return entries, nil
}

// Projects returns known project names, most recently used first, followed by
// registered projects that have never been tracked.
func (l *Logbook) Projects(ctx context.Context) ([]string, error) {
	acts, err := l.repo.Find(ctx, models.ActivityFilter{})
	if err != nil {
		return nil, errors.Wrap(err, "list activities")
	}
	seen := map[string]bool{}
	var names []string
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		names = append(names, name)
	}
	for _, act := range slices.Backward(acts) {
		add(act.Project)
	}
	if l.registered != nil {
		for _, name := range l.registered() {
			add(name)
		}
	}
	return names, nil
}

// Add records a completed activity. It refuses entries in the future and any
// that overlap existing time: the repository keys rows by start time, so an
// unchecked insert at an existing start would silently overwrite that entry.
func (l *Logbook) Add(ctx context.Context, req AddRequest) (Entry, error) {
	end := req.End.Truncate(time.Second)
	act := models.Activity{
		Description: strings.TrimSpace(req.Description),
		Project:     strings.TrimSpace(req.Project),
		StartTime:   req.Start.Truncate(time.Second),
		EndTime:     &end,
		Notes:       strings.TrimSpace(req.Notes),
	}
	if err := l.validate(ctx, act, nil); err != nil {
		return Entry{}, err
	}
	if err := l.repo.Save(ctx, act); err != nil {
		return Entry{}, errors.Wrap(err, "add activity")
	}
	return l.entry(act), nil
}

// Update edits the entry that starts at start. A running entry stays running
// unless an end is given.
func (l *Logbook) Update(ctx context.Context, start time.Time, req UpdateRequest) (Entry, error) {
	orig, err := l.find(ctx, start)
	if err != nil {
		return Entry{}, err
	}

	updated := orig
	if req.Description != nil {
		updated.Description = strings.TrimSpace(*req.Description)
	}
	if req.Project != nil {
		updated.Project = strings.TrimSpace(*req.Project)
	}
	if req.Notes != nil {
		updated.Notes = strings.TrimSpace(*req.Notes)
	}
	if req.Start != nil {
		updated.StartTime = req.Start.Truncate(time.Second)
	}
	if req.End != nil {
		end := req.End.Truncate(time.Second)
		updated.EndTime = &end
	}
	if err = l.validate(ctx, updated, &orig); err != nil {
		return Entry{}, err
	}

	// Write the log before the tombstone: sync reads tombstones first, so it
	// never sees one whose entry is still listed in its original form.
	if !updated.StartTime.Equal(orig.StartTime) {
		if err = l.repo.Remove(ctx, orig); err != nil {
			return Entry{}, errors.Wrap(err, "move activity")
		}
	}
	if err = l.repo.Save(ctx, updated); err != nil {
		return Entry{}, errors.Wrap(err, "update activity")
	}
	if err = l.recordDeletion(orig); err != nil {
		return Entry{}, err
	}
	return l.entry(updated), nil
}

// Delete removes the entry that starts at start and returns it as it was, so a
// mistaken delete can be re-added.
func (l *Logbook) Delete(ctx context.Context, start time.Time) (Entry, error) {
	orig, err := l.find(ctx, start)
	if err != nil {
		return Entry{}, err
	}
	if err = l.repo.Remove(ctx, orig); err != nil {
		return Entry{}, errors.Wrap(err, "delete activity")
	}
	if err = l.recordDeletion(orig); err != nil {
		return Entry{}, err
	}
	return l.entry(orig), nil
}

func (l *Logbook) recordDeletion(orig models.Activity) error {
	if l.deletions == nil {
		return nil
	}
	if err := l.deletions.RecordDeletion(orig); err != nil {
		return errors.Wrap(err, "saved locally, but sync may restore the previous version")
	}
	return nil
}

// find matches at second precision because entries are listed that way, while
// entries started live in the app are stored with sub-second starts.
func (l *Logbook) find(ctx context.Context, start time.Time) (models.Activity, error) {
	from := start.Truncate(time.Second)
	to := from.Add(time.Second)
	acts, err := l.repo.Find(ctx, models.ActivityFilter{FromDate: &from, ToDate: &to})
	if err != nil {
		return models.Activity{}, errors.Wrap(err, "find activity")
	}
	for _, act := range acts {
		if act.StartTime.Truncate(time.Second).Equal(from) {
			return act, nil
		}
	}
	return models.Activity{}, errors.Errorf(
		"no entry starts at %s; use the start of an entry from list_activities",
		from.Local().Format(time.RFC3339),
	)
}

// validate checks act as it would be stored. orig, when set, is the entry being
// edited and is not counted as an overlap.
func (l *Logbook) validate(ctx context.Context, act models.Activity, orig *models.Activity) error {
	now := l.now()
	if act.Description == "" {
		return errors.New("description is required")
	}
	end := now.Add(time.Second)
	if act.EndTime != nil {
		end = *act.EndTime
		if !end.After(act.StartTime) {
			return errors.New("end must be after start")
		}
		if end.After(now) {
			return errors.New("end is in the future; only work that has happened can be recorded")
		}
	} else if act.StartTime.After(now) {
		return errors.New("start is in the future")
	}

	overlapping, err := l.repo.Find(ctx, models.ActivityFilter{FromDate: &act.StartTime, ToDate: &end})
	if err != nil {
		return errors.Wrap(err, "check overlaps")
	}
	var conflicts []Entry
	for _, other := range overlapping {
		if orig != nil && other.StartTime.Equal(orig.StartTime) {
			continue
		}
		conflicts = append(conflicts, l.entry(other))
	}
	if len(conflicts) > 0 {
		return &OverlapError{Conflicts: conflicts}
	}
	return nil
}

func (l *Logbook) entry(act models.Activity) Entry {
	e := Entry{
		Start:       act.StartTime.Local().Format(time.RFC3339),
		Project:     act.Project,
		Description: act.Description,
		Notes:       act.Notes,
	}
	end := l.now()
	if act.EndTime != nil {
		end = *act.EndTime
		e.End = end.Local().Format(time.RFC3339)
	} else {
		e.Running = true
	}
	e.Minutes = int(end.Sub(act.StartTime).Round(time.Minute) / time.Minute)
	return e
}

// ParseTime accepts RFC 3339 or a local "YYYY-MM-DD HH:MM" (a "T" separator
// and seconds are also fine).
func ParseTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.Errorf("invalid time %q: use RFC 3339 or YYYY-MM-DD HH:MM (local)", s)
}

// ParseRange resolves list bounds. A bare YYYY-MM-DD is a whole local day, so
// from=2026-09-01 to=2026-09-07 covers seven days inclusive.
func ParseRange(from, to string) (time.Time, time.Time, error) {
	start, err := parseBound(from, false)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	end, err := parseBound(to, true)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	return start, end, nil
}

func parseBound(s string, endOfDay bool) (time.Time, error) {
	s = strings.TrimSpace(s)
	if day, err := time.ParseInLocation(time.DateOnly, s, time.Local); err == nil {
		if endOfDay {
			return day.AddDate(0, 0, 1), nil
		}
		return day, nil
	}
	return ParseTime(s)
}
