package main

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/app/runtime"
	"github.com/kriuchkov/tock/internal/core/models"
)

// App is the Wails-bound surface for the Toki desktop window. It owns a tock
// Runtime so the GUI talks to the same services and the same data file the
// `tock` CLI does — there is no parallel implementation of any business rule.
type App struct {
	ctx context.Context
	rt  *runtime.Runtime
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	rt, err := runtime.Load(ctx, runtime.Request{})
	if err != nil {
		return
	}
	a.rt = rt
}

func (a *App) requireRuntime() error {
	if a.rt == nil {
		return errors.New("toki couldn't reach the tock data file")
	}
	return nil
}

// GetRunning returns the activity currently being tracked, or nil if nothing
// is running. The window's hero state.
func (a *App) GetRunning() (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	running := true
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{IsRunning: &running})
	if err != nil {
		return nil, err
	}
	if len(acts) == 0 {
		return nil, nil
	}
	// Pick the latest start time in case multiple slipped through.
	latest := acts[0]
	for _, act := range acts[1:] {
		if act.StartTime.After(latest.StartTime) {
			latest = act
		}
	}
	return &latest, nil
}

// ListToday returns activities that started today, oldest first — the order
// you read a logbook.
func (a *App) ListToday() ([]models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	now := time.Now()
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	to := from.Add(24 * time.Hour)
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{FromDate: &from, ToDate: &to})
	if err != nil {
		return nil, err
	}
	return acts, nil
}

// Start begins a new activity. Description is required; project is optional.
// Starting a new one stops anything already running (tock's own behavior).
func (a *App) Start(description, project string) (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("describe what you're working on")
	}
	return a.rt.ActivityService.Start(a.ctx, models.StartActivityRequest{
		Description: description,
		Project:     strings.TrimSpace(project),
	})
}

// Stop ends the running activity.
func (a *App) Stop() (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	return a.rt.ActivityService.Stop(a.ctx, models.StopActivityRequest{})
}

// UpdateActivity edits an existing activity. Description and project change
// in place. Start and end times may also change: if startISO differs from the
// original start, the activity is moved to the new start time (the repo's
// key) by removing the original row and saving under the new key. End time
// changes are applied in place.
func (a *App) UpdateActivity(orig models.Activity, description, project, startISO, endISO string) (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("describe what you were working on")
	}
	updated := orig
	updated.Description = description
	updated.Project = strings.TrimSpace(project)

	newStart := orig.StartTime
	if s := strings.TrimSpace(startISO); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return nil, errors.Wrap(err, "parse start time")
		}
		newStart = t
	}

	newEnd := updated.EndTime
	if s := strings.TrimSpace(endISO); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return nil, errors.Wrap(err, "parse end time")
		}
		newEnd = &t
	}

	if newEnd != nil && newStart.After(*newEnd) {
		return nil, errors.New("start must not be after end")
	}

	if !newStart.Equal(orig.StartTime) {
		if err := a.rt.ActivityService.Remove(a.ctx, orig); err != nil {
			return nil, err
		}
		updated.StartTime = newStart
	}
	updated.EndTime = newEnd

	if err := a.rt.ActivityRepo.Save(a.ctx, updated); err != nil {
		return nil, err
	}
	return &updated, nil
}

// RemoveActivity deletes an activity.
func (a *App) RemoveActivity(orig models.Activity) error {
	if err := a.requireRuntime(); err != nil {
		return err
	}
	return a.rt.ActivityService.Remove(a.ctx, orig)
}

// ListRecent returns up to `limit` activities, newest start time first,
// without deduplication — the historical stream the logbook browses.
func (a *App) ListRecent(limit int) ([]models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 200
	}
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{})
	if err != nil {
		return nil, err
	}
	sort.Slice(acts, func(i, j int) bool {
		return acts[i].StartTime.After(acts[j].StartTime)
	})
	if len(acts) > limit {
		acts = acts[:limit]
	}
	return acts, nil
}

// Projects returns distinct project names seen recently — feeds the small-caps
// hint chip below the input.
func (a *App) Projects() ([]string, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	recent, err := a.rt.ActivityService.GetRecent(a.ctx, 100)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	out := []string{}
	for _, act := range recent {
		p := strings.TrimSpace(act.Project)
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
		if len(out) >= 8 {
			break
		}
	}
	return out, nil
}
