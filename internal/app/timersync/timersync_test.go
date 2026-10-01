package timersync

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync"
)

// record is the shared running-timer row, with the version check the Data API
// enforces.
type record struct {
	mu    sync.Mutex
	state neonsync.TimerState
}

func (r *record) put(seen int64, t neonsync.RunningTimer) (neonsync.TimerState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seen != r.state.Version {
		return r.state, neonsync.ErrTimerConflict
	}
	r.state = neonsync.TimerState{Version: seen + 1, Timer: &t}
	return r.state, nil
}

type device struct {
	id  string
	rec *record
}

func (d *device) RunningTimer(context.Context) (neonsync.TimerState, error) {
	d.rec.mu.Lock()
	defer d.rec.mu.Unlock()
	return d.rec.state, nil
}

func (d *device) PutRunningTimer(_ context.Context, seen int64, t neonsync.RunningTimer) (neonsync.TimerState, error) {
	return d.rec.put(seen, t)
}

func (d *device) DeviceID() (string, error) { return d.id, nil }

// log is an in-memory activity store with the activity service's semantics:
// rows are keyed by start time and a start stops whatever is running.
type log struct{ acts []models.Activity }

func (l *log) List(_ context.Context, f models.ActivityFilter) ([]models.Activity, error) {
	var out []models.Activity
	for _, a := range l.acts {
		if f.IsRunning != nil && *f.IsRunning != (a.EndTime == nil) {
			continue
		}
		if f.FromDate != nil && a.EndTime != nil && !a.EndTime.After(*f.FromDate) {
			continue
		}
		if f.ToDate != nil && !a.StartTime.Before(*f.ToDate) {
			continue
		}
		out = append(out, a)
	}
	return out, nil
}

func (l *log) Start(_ context.Context, req models.StartActivityRequest) (*models.Activity, error) {
	start := req.StartTime
	if start.IsZero() {
		start = time.Now()
	}
	for i := range l.acts {
		if l.acts[i].EndTime == nil {
			end := start
			if end.Before(l.acts[i].StartTime) {
				end = time.Now()
			}
			l.acts[i].EndTime = &end
		}
	}
	a := models.Activity{Description: req.Description, Project: req.Project, StartTime: start, Notes: req.Notes, Tags: req.Tags}
	l.acts = append(l.acts, a)
	return &a, nil
}

func (l *log) Stop(_ context.Context, req models.StopActivityRequest) (*models.Activity, error) {
	for i := range l.acts {
		if l.acts[i].EndTime == nil {
			end := req.EndTime
			if end.IsZero() {
				end = time.Now()
			}
			l.acts[i].EndTime = &end
			return &l.acts[i], nil
		}
	}
	return nil, errors.New("nothing running")
}

func (l *log) Remove(_ context.Context, a models.Activity) error {
	l.acts = slices.DeleteFunc(l.acts, func(x models.Activity) bool { return x.StartTime.Equal(a.StartTime) })
	return nil
}

type peer struct {
	log  *log
	sync *Syncer
}

func newPeer(t *testing.T, id string, rec *record) *peer {
	t.Helper()
	l := &log{}
	return &peer{log: l, sync: New(&device{id: id, rec: rec}, l, filepath.Join(t.TempDir(), "timersync.json"))}
}

func (p *peer) reconcile(t *testing.T) bool {
	t.Helper()
	changed, err := p.sync.Reconcile(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return changed
}

func (p *peer) start(t *testing.T, desc string, at time.Time) {
	t.Helper()
	if _, err := p.log.Start(t.Context(), models.StartActivityRequest{Description: desc, StartTime: at}); err != nil {
		t.Fatal(err)
	}
}

func (p *peer) running() *models.Activity {
	for i := range p.log.acts {
		if p.log.acts[i].EndTime == nil {
			return &p.log.acts[i]
		}
	}
	return nil
}

var t0 = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

func TestStartAndStopReachTheOtherDevice(t *testing.T) {
	rec := &record{}
	mac, laptop := newPeer(t, "mac", rec), newPeer(t, "laptop", rec)

	mac.start(t, "Plan", t0)
	if mac.reconcile(t) {
		t.Fatal("publishing a local start should not report a local change")
	}
	if rec.state.Version != 1 || rec.state.Timer.DeviceID != "mac" {
		t.Fatalf("record after start = %+v", rec.state)
	}
	if !laptop.reconcile(t) {
		t.Fatal("laptop should adopt the mac's timer")
	}
	if r := laptop.running(); r == nil || r.Description != "Plan" || !r.StartTime.Equal(t0) {
		t.Fatalf("laptop running = %+v", r)
	}

	// Stopping on the laptop closes the mac's copy at the same instant.
	if _, err := laptop.log.Stop(t.Context(), models.StopActivityRequest{EndTime: t0.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	laptop.reconcile(t)
	if !mac.reconcile(t) {
		t.Fatal("mac should adopt the stop")
	}
	if mac.running() != nil || len(mac.log.acts) != 1 || !mac.log.acts[0].EndTime.Equal(t0.Add(time.Hour)) {
		t.Fatalf("mac log = %+v", mac.log.acts)
	}
	if mac.reconcile(t) || laptop.reconcile(t) {
		t.Fatal("converged devices should be quiet")
	}
}

func TestStartingElsewhereStopsTheLocalTimer(t *testing.T) {
	rec := &record{}
	mac, phone := newPeer(t, "mac", rec), newPeer(t, "phone", rec)
	mac.start(t, "Plan", t0)
	mac.reconcile(t)
	phone.reconcile(t)

	phone.start(t, "Review", t0.Add(30*time.Minute))
	phone.reconcile(t)
	mac.reconcile(t)

	if r := mac.running(); r == nil || r.Description != "Review" {
		t.Fatalf("mac running = %+v", r)
	}
	if !mac.log.acts[0].EndTime.Equal(t0.Add(30 * time.Minute)) {
		t.Fatalf("mac's own timer should stop at the new start, got %v", mac.log.acts[0].EndTime)
	}
}

func TestDeletingTheRunningTimerDeletesItEverywhere(t *testing.T) {
	rec := &record{}
	mac, laptop := newPeer(t, "mac", rec), newPeer(t, "laptop", rec)
	mac.start(t, "Oops", t0)
	mac.reconcile(t)
	laptop.reconcile(t)

	if err := mac.log.Remove(t.Context(), *mac.running()); err != nil {
		t.Fatal(err)
	}
	mac.reconcile(t)
	if !rec.state.Timer.Discarded {
		t.Fatalf("record should be discarded, got %+v", rec.state.Timer)
	}
	laptop.reconcile(t)
	if len(laptop.log.acts) != 0 {
		t.Fatalf("laptop log = %+v", laptop.log.acts)
	}
}

func TestEditPropagates(t *testing.T) {
	rec := &record{}
	mac, laptop := newPeer(t, "mac", rec), newPeer(t, "laptop", rec)
	mac.start(t, "Plan", t0)
	mac.reconcile(t)
	laptop.reconcile(t)

	mac.log.acts[0].Description = "Plan the release"
	mac.log.acts[0].Project = "tokify"
	mac.reconcile(t)
	laptop.reconcile(t)
	if r := laptop.running(); r == nil || r.Description != "Plan the release" || r.Project != "tokify" {
		t.Fatalf("laptop running = %+v", r)
	}
	if rec.state.Timer.DeviceID != "mac" {
		t.Fatalf("an edit should keep the starting device, got %q", rec.state.Timer.DeviceID)
	}
}

func TestRaceNewerStartWins(t *testing.T) {
	rec := &record{}
	mac, laptop := newPeer(t, "mac", rec), newPeer(t, "laptop", rec)

	// Both start before either has heard from the other.
	mac.start(t, "Mac work", t0)
	laptop.start(t, "Laptop work", t0.Add(time.Minute))
	mac.reconcile(t)
	laptop.reconcile(t) // loses the version race, but its start is newer
	mac.reconcile(t)
	laptop.reconcile(t)

	for _, p := range []*peer{mac, laptop} {
		if r := p.running(); r == nil || r.Description != "Laptop work" {
			t.Fatalf("running = %+v", r)
		}
	}
	if !mac.log.acts[0].EndTime.Equal(t0.Add(time.Minute)) {
		t.Fatalf("mac's timer should stop at the laptop's start, got %v", mac.log.acts[0].EndTime)
	}
	if mac.reconcile(t) || laptop.reconcile(t) {
		t.Fatal("converged devices should be quiet")
	}
}

func TestRaceOlderStartLoses(t *testing.T) {
	rec := &record{}
	mac, laptop := newPeer(t, "mac", rec), newPeer(t, "laptop", rec)

	mac.start(t, "Mac work", t0.Add(time.Minute))
	laptop.start(t, "Laptop work", t0)
	mac.reconcile(t)
	laptop.reconcile(t)
	mac.reconcile(t)

	for _, p := range []*peer{mac, laptop} {
		if r := p.running(); r == nil || r.Description != "Mac work" {
			t.Fatalf("running = %+v", r)
		}
	}
}

func TestAgreedStateSurvivesRestart(t *testing.T) {
	rec := &record{}
	dir := t.TempDir()
	l := &log{}
	first := New(&device{id: "mac", rec: rec}, l, filepath.Join(dir, "timersync.json"))
	if _, err := l.Start(t.Context(), models.StartActivityRequest{Description: "Plan", StartTime: t0}); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}

	// Stopped while the app was closed, then relaunched.
	if _, err := l.Stop(t.Context(), models.StopActivityRequest{EndTime: t0.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	second := New(&device{id: "mac", rec: rec}, l, filepath.Join(dir, "timersync.json"))
	if _, err := second.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if end := rec.state.Timer.End; end == nil || !end.Equal(t0.Add(time.Hour)) {
		t.Fatalf("the offline stop should be published, record = %+v", rec.state.Timer)
	}
}
