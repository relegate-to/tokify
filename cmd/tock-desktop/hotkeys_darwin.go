//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Carbon -framework Cocoa

#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>

extern void tokifyHotKeyPressed(unsigned int id);

#define MAX_HOTKEYS 64

static EventHandlerRef handlerRef = NULL;
static EventHotKeyRef hotKeyRefs[MAX_HOTKEYS];

static OSStatus onHotKey(EventHandlerCallRef next, EventRef event, void *data) {
	EventHotKeyID hk;
	if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(hk), NULL, &hk) == noErr) {
		tokifyHotKeyPressed(hk.id);
	}
	return noErr;
}

static void onMainThread(dispatch_block_t block) {
	if ([NSThread isMainThread]) {
		block();
	} else {
		dispatch_sync(dispatch_get_main_queue(), block);
	}
}

// Carbon's hot keys are delivered to the app wherever focus is and need no
// Accessibility permission, unlike a global key monitor.
static int registerHotKey(unsigned int id, unsigned int keyCode, unsigned int modifiers) {
	if (id >= MAX_HOTKEYS) {
		return -1;
	}
	__block OSStatus status = noErr;
	onMainThread(^{
		if (handlerRef == NULL) {
			EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
			InstallApplicationEventHandler(&onHotKey, 1, &spec, NULL, &handlerRef);
		}
		EventHotKeyID hk = {'tkfy', id};
		status = RegisterEventHotKey(keyCode, modifiers, hk, GetApplicationEventTarget(), 0, &hotKeyRefs[id]);
	});
	return (int)status;
}

static void unregisterHotKeys(void) {
	onMainThread(^{
		for (int i = 0; i < MAX_HOTKEYS; i++) {
			if (hotKeyRefs[i] != NULL) {
				UnregisterEventHotKey(hotKeyRefs[i]);
				hotKeyRefs[i] = NULL;
			}
		}
	});
}
*/
import "C"

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/go-faster/errors"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/kriuchkov/tock/internal/app/hotkeys"
	"github.com/kriuchkov/tock/internal/core/models"
)

// Carbon modifier masks (HIToolbox/Events.h).
const (
	carbonCmd   = 1 << 8
	carbonShift = 1 << 9
	carbonAlt   = 1 << 11
	carbonCtrl  = 1 << 12
)

// The registered global bindings, by the id Carbon hands back on a press.
// Carbon calls back into Go through a C function, which carries no App, so the
// table lives at package level.
//
//nolint:gochecknoglobals // see above.
var globalHotkeys = struct {
	mu      sync.Mutex
	app     *App
	actions map[uint32]hotkeys.Action
}{actions: map[uint32]hotkeys.Action{}}

// hotKeyPressed runs the action bound to a pressed global shortcut.
func hotKeyPressed(id uint32) {
	globalHotkeys.mu.Lock()
	app, action := globalHotkeys.app, globalHotkeys.actions[id]
	globalHotkeys.mu.Unlock()
	if app != nil && action != "" {
		go app.runHotkeyAction(action)
	}
}

func carbonModifiers(s hotkeys.Shortcut) C.uint {
	var m C.uint
	if s.Cmd {
		m |= carbonCmd
	}
	if s.Shift {
		m |= carbonShift
	}
	if s.Alt {
		m |= carbonAlt
	}
	if s.Ctrl {
		m |= carbonCtrl
	}
	return m
}

// registerGlobalHotkeys replaces the registered set with the global bindings,
// returning a message for each one macOS refused (usually because another app
// already owns that shortcut).
func (a *App) registerGlobalHotkeys(bindings []hotkeys.Binding) []string {
	C.unregisterHotKeys()
	globalHotkeys.mu.Lock()
	defer globalHotkeys.mu.Unlock()
	globalHotkeys.app = a
	globalHotkeys.actions = map[uint32]hotkeys.Action{}
	var failed []string
	var id uint32
	for _, b := range bindings {
		if !b.Global {
			continue
		}
		code, ok := hotkeys.MacKeyCode(b.Shortcut.Key)
		if !ok {
			continue
		}
		if status := C.registerHotKey(C.uint(id), C.uint(code), carbonModifiers(b.Shortcut)); status != 0 {
			failed = append(failed, fmt.Sprintf("%s is already in use by macOS or another app.", b.Shortcut))
			continue
		}
		globalHotkeys.actions[id] = b.Action
		id++
	}
	return failed
}

// Hotkeys returns the saved shortcuts, or the defaults before any are saved.
func (a *App) Hotkeys() []hotkeys.Binding {
	if saved := loadDesktopPrefs().Hotkeys; saved != nil {
		return saved
	}
	return hotkeys.Defaults()
}

// HotkeyDefaults returns the shortcuts a fresh install starts with.
func (a *App) HotkeyDefaults() []hotkeys.Binding {
	return hotkeys.Defaults()
}

// SetHotkeys validates and saves the whole set of shortcuts and registers the
// global ones. A shortcut macOS refuses is saved anyway (it may free up) and
// reported in the returned messages.
func (a *App) SetHotkeys(bindings []hotkeys.Binding) ([]string, error) {
	if bindings == nil {
		bindings = []hotkeys.Binding{}
	}
	if err := hotkeys.Validate(bindings); err != nil {
		return nil, err
	}
	prefs := loadDesktopPrefs()
	prefs.Hotkeys = bindings
	if err := saveDesktopPrefs(prefs); err != nil {
		return nil, errors.Wrap(err, "save shortcuts")
	}
	return a.registerGlobalHotkeys(bindings), nil
}

// PauseHotkeys lifts the global shortcuts while Settings records a new one,
// so pressing a combination that is already bound records it instead of
// running it.
func (a *App) PauseHotkeys(paused bool) {
	if paused {
		C.unregisterHotKeys()
		return
	}
	a.registerGlobalHotkeys(a.Hotkeys())
}

// RunHotkeyAction runs an action for a shortcut pressed inside the window, so
// window and global shortcuts behave the same.
func (a *App) RunHotkeyAction(action string) error {
	if !hotkeys.Known(hotkeys.Action(action)) {
		return errors.Errorf("unknown action %q", action)
	}
	a.runHotkeyAction(hotkeys.Action(action))
	return nil
}

func (a *App) runHotkeyAction(action hotkeys.Action) {
	if a.ctx == nil {
		return
	}
	switch action {
	case hotkeys.ToggleTimer:
		if running, err := a.GetRunning(); err == nil && running != nil {
			a.stopFromHotkey()
		} else {
			a.startFromTray(a.lastActivity)
		}
	case hotkeys.StopTimer:
		a.stopFromHotkey()
	case hotkeys.ResumeLast:
		a.startFromTray(a.lastActivity)
	case hotkeys.ShowTokify:
		a.showMain()
	case hotkeys.NewActivity:
		a.navigateTo("now")
		wailsruntime.EventsEmit(a.ctx, "hotkey:new-activity")
	case hotkeys.ViewNow:
		a.navigateTo("now")
	case hotkeys.ViewLog:
		a.navigateTo("history")
	case hotkeys.ViewNotes:
		a.navigateTo("sketchpad")
	case hotkeys.ViewReports:
		a.navigateTo("reports")
	case hotkeys.ViewCharts:
		a.navigateTo("charts")
	case hotkeys.ViewStats:
		a.navigateTo("stats")
	case hotkeys.OpenSettings:
		a.navigateTo("settings")
	}
}

func (a *App) navigateTo(view string) {
	a.showMain()
	wailsruntime.EventsEmit(a.ctx, "tray:navigate", view)
}

func (a *App) stopFromHotkey() {
	if _, err := a.Stop(); err == nil {
		wailsruntime.EventsEmit(a.ctx, "activities:changed")
	}
}

// lastActivity is what Resume starts: the tray's last finished activity, or
// the most recent one in the log before the tray has rendered.
func (a *App) lastActivity() *models.Activity {
	if act := a.trayResume(); act != nil {
		return act
	}
	if a.rt == nil {
		return nil
	}
	recent, err := a.rt.ActivityService.GetRecent(context.Background(), 1)
	if err != nil || len(recent) == 0 {
		return nil
	}
	return &recent[0]
}

// startHotkeys registers the saved global shortcuts at launch. A shortcut
// macOS refuses is only logged here; Settings shows it when opened.
func (a *App) startHotkeys() {
	for _, msg := range a.registerGlobalHotkeys(a.Hotkeys()) {
		fmt.Fprintf(os.Stderr, "Tokify: shortcut: %s\n", msg)
	}
}
