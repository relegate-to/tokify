//go:build darwin

package main

import (
	"context"
	"errors"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// sketchpadDebounce is how long after the last edit the pad syncs, so typing
// collapses into one write.
const sketchpadDebounce = 2 * time.Second

// SketchpadLoad returns the sketchpad. On the first load it adopts legacy, the
// copy the window kept in local storage before the pad moved here.
func (a *App) SketchpadLoad(legacy string) (string, error) {
	if a.sketchpad == nil {
		return legacy, errors.New("sketchpad unavailable")
	}
	return a.sketchpad.Load(legacy)
}

// SketchpadSave stores an edit the window made from base, merged with whatever
// a sync brought in meanwhile, and returns the pad as it now stands.
func (a *App) SketchpadSave(base, html string) (string, error) {
	if a.sketchpad == nil {
		return html, errors.New("sketchpad unavailable")
	}
	out, err := a.sketchpad.Save(base, html)
	if err == nil {
		a.syncSketchpadSoon()
	}
	return out, err
}

// RefreshSketchpad checks for edits made on another device. The window calls
// it on its poll.
func (a *App) RefreshSketchpad() {
	a.syncSketchpad()
}

func (a *App) syncSketchpadSoon() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.padTimer == nil {
		a.padTimer = time.AfterFunc(sketchpadDebounce, a.syncSketchpad)
		return
	}
	a.padTimer.Reset(sketchpadDebounce)
}

// syncSketchpad shares the pad with the account's other devices and hands the
// window the result when that changed it. Quiet on failure like the other
// background syncs; the next poll retries.
func (a *App) syncSketchpad() {
	if a.sketchpad == nil || a.neonAuth == nil || !a.neonAuth.Status().SignedIn {
		return
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	changed, err := a.sketchpad.Sync(ctx)
	if err != nil || !changed {
		return
	}
	wailsruntime.EventsEmit(a.ctx, "sketchpad:changed", a.sketchpad.Text())
}
