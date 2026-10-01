// Package timersync keeps this device's running activity in step with the
// account's running-timer record (neonsync.RunningTimer), so a timer started or
// stopped on one device shows up on the others.
//
// Each Reconcile compares three states: the remote record, the local running
// activity, and the last state this device agreed with (persisted, so a change
// made offline or before a restart is still recognised as local). Whichever
// side moved since then wins; when both moved, the newer event wins and the
// other device converges on its next reconcile.
package timersync

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync"
)

// Remote is the running-timer record. Satisfied by *neonsync.Service.
type Remote interface {
	RunningTimer(ctx context.Context) (neonsync.TimerState, error)
	PutRunningTimer(ctx context.Context, seen int64, timer neonsync.RunningTimer) (neonsync.TimerState, error)
	DeviceID() (string, error)
}

// Local is the slice of the activity service a reconcile reads and writes.
// Satisfied by ports.ActivityResolver.
type Local interface {
	List(ctx context.Context, filter models.ActivityFilter) ([]models.Activity, error)
	Start(ctx context.Context, req models.StartActivityRequest) (*models.Activity, error)
	Stop(ctx context.Context, req models.StopActivityRequest) (*models.Activity, error)
	Remove(ctx context.Context, activity models.Activity) error
}

type Syncer struct {
	remote Remote
	local  Local
	path   string
	mu     sync.Mutex
}

func New(remote Remote, local Local, path string) *Syncer {
	return &Syncer{remote: remote, local: local, path: path}
}

// agreed is the last state both sides held, persisted between reconciles.
type agreed struct {
	Version int64                  `json:"version"`
	Timer   *neonsync.RunningTimer `json:"timer,omitempty"`
}

// Reconcile brings the local running activity and the remote record into
// agreement. It reports whether it changed local activities, so the caller can
// refresh what it shows. A reconcile already in flight makes this a no-op.
func (s *Syncer) Reconcile(ctx context.Context) (bool, error) {
	if !s.mu.TryLock() {
		return false, nil
	}
	defer s.mu.Unlock()

	last, err := s.load()
	if err != nil {
		return false, err
	}
	remote, err := s.remote.RunningTimer(ctx)
	if err != nil {
		return false, err
	}
	view, err := s.localView(ctx, last)
	if err != nil {
		return false, err
	}

	localMoved := !sameTimer(view, last.Timer)
	remoteMoved := remote.Version != last.Version
	switch {
	case !localMoved && !remoteMoved:
		return false, nil
	case localMoved && !remoteMoved:
		next, perr := s.remote.PutRunningTimer(ctx, last.Version, *view)
		if errors.Is(perr, neonsync.ErrTimerConflict) {
			return s.settle(ctx, next, view)
		}
		if perr != nil {
			return false, perr
		}
		return false, s.save(next)
	case !localMoved:
		return s.adopt(ctx, remote)
	default:
		return s.settle(ctx, remote, view)
	}
}

// settle resolves both sides having moved: the newer event wins. A local win
// overwrites the record, and the device whose timer it replaced stops its copy
// when it next reconciles.
func (s *Syncer) settle(ctx context.Context, remote neonsync.TimerState, view *neonsync.RunningTimer) (bool, error) {
	if view == nil || remote.Timer != nil && !eventTime(*view).After(eventTime(*remote.Timer)) {
		return s.adopt(ctx, remote)
	}
	next, err := s.remote.PutRunningTimer(ctx, remote.Version, *view)
	if errors.Is(err, neonsync.ErrTimerConflict) {
		// Moved again under us; the next reconcile settles it.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return false, s.save(next)
}

// adopt applies the remote record locally and records it as agreed.
func (s *Syncer) adopt(ctx context.Context, remote neonsync.TimerState) (bool, error) {
	changed, err := s.apply(ctx, remote.Timer)
	if err != nil {
		return changed, err
	}
	return changed, s.save(remote)
}

// apply makes the local activities reflect t. Starting it locally stops any
// other running activity at its start time, as a local start would.
func (s *Syncer) apply(ctx context.Context, t *neonsync.RunningTimer) (bool, error) {
	if t == nil {
		return false, nil
	}
	running, err := s.running(ctx)
	if err != nil {
		return false, err
	}
	same := running != nil && running.StartTime.Equal(t.Start)

	switch {
	case t.Discarded:
		if !same {
			return false, nil
		}
		return true, s.local.Remove(ctx, *running)
	case t.End != nil:
		if !same {
			return false, nil
		}
		_, err = s.local.Stop(ctx, models.StopActivityRequest{EndTime: *t.End})
		return err == nil, err
	case same:
		if matches(*running, *t) {
			return false, nil
		}
		// An edit on another device: replace the running row in place.
		if err = s.local.Remove(ctx, *running); err != nil {
			return false, err
		}
	default:
		taken, aerr := s.activityAt(ctx, t.Start)
		if aerr != nil || taken != nil {
			return false, aerr
		}
	}
	_, err = s.local.Start(ctx, models.StartActivityRequest{
		Description: t.Description,
		Project:     t.Project,
		StartTime:   t.Start,
		Notes:       t.Notes,
		Tags:        t.Tags,
	})
	return err == nil, err
}

// localView is the timer this device would publish: its running activity, or
// the last agreed timer as it now stands locally (stopped, or deleted).
func (s *Syncer) localView(ctx context.Context, last agreed) (*neonsync.RunningTimer, error) {
	running, err := s.running(ctx)
	if err != nil {
		return nil, err
	}
	if running != nil {
		device := ""
		if last.Timer != nil && last.Timer.Start.Equal(running.StartTime) {
			device = last.Timer.DeviceID
		}
		if device == "" {
			if device, err = s.remote.DeviceID(); err != nil {
				return nil, err
			}
		}
		t := timerFrom(*running, device)
		return &t, nil
	}
	if last.Timer == nil || last.Timer.End != nil || last.Timer.Discarded {
		return last.Timer, nil
	}
	act, err := s.activityAt(ctx, last.Timer.Start)
	if err != nil {
		return nil, err
	}
	if act == nil {
		t := *last.Timer
		t.Discarded = true
		return &t, nil
	}
	t := timerFrom(*act, last.Timer.DeviceID)
	return &t, nil
}

func (s *Syncer) running(ctx context.Context) (*models.Activity, error) {
	isRunning := true
	acts, err := s.local.List(ctx, models.ActivityFilter{IsRunning: &isRunning})
	if err != nil {
		return nil, err
	}
	var latest *models.Activity
	for i := range acts {
		if latest == nil || acts[i].StartTime.After(latest.StartTime) {
			latest = &acts[i]
		}
	}
	return latest, nil
}

func (s *Syncer) activityAt(ctx context.Context, start time.Time) (*models.Activity, error) {
	from, to := start.Add(-time.Second), start.Add(time.Second)
	acts, err := s.local.List(ctx, models.ActivityFilter{FromDate: &from, ToDate: &to})
	if err != nil {
		return nil, err
	}
	for i := range acts {
		if acts[i].StartTime.Equal(start) {
			return &acts[i], nil
		}
	}
	return nil, nil
}

func timerFrom(a models.Activity, device string) neonsync.RunningTimer {
	return neonsync.RunningTimer{
		Description: a.Description,
		Project:     a.Project,
		Notes:       a.Notes,
		Tags:        a.Tags,
		Start:       a.StartTime,
		End:         a.EndTime,
		DeviceID:    device,
	}
}

func matches(a models.Activity, t neonsync.RunningTimer) bool {
	return a.Description == t.Description && a.Project == t.Project &&
		a.Notes == t.Notes && slices.Equal(a.Tags, t.Tags)
}

// sameTimer compares what a timer says, ignoring which device started it.
func sameTimer(a, b *neonsync.RunningTimer) bool {
	if a == nil || b == nil {
		return a == b
	}
	endsMatch := a.End == nil && b.End == nil || a.End != nil && b.End != nil && a.End.Equal(*b.End)
	return a.Start.Equal(b.Start) && endsMatch && a.Discarded == b.Discarded &&
		a.Description == b.Description && a.Project == b.Project &&
		a.Notes == b.Notes && slices.Equal(a.Tags, b.Tags)
}

// eventTime is when a timer last changed state: its stop, else its start.
func eventTime(t neonsync.RunningTimer) time.Time {
	if t.End != nil {
		return *t.End
	}
	return t.Start
}

func (s *Syncer) load() (agreed, error) {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return agreed{}, nil
	}
	if err != nil {
		return agreed{}, errors.Wrap(err, "read timer sync state")
	}
	var a agreed
	if uerr := json.Unmarshal(data, &a); uerr != nil {
		return agreed{}, errors.Wrap(uerr, "decode timer sync state")
	}
	return a, nil
}

func (s *Syncer) save(state neonsync.TimerState) error {
	data, err := json.Marshal(agreed{Version: state.Version, Timer: state.Timer})
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return errors.Wrap(err, "ensure timer sync dir")
	}
	if err = os.WriteFile(s.path, data, 0o600); err != nil {
		return errors.Wrap(err, "write timer sync state")
	}
	return nil
}
