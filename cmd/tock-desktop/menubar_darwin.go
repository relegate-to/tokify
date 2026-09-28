//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

static BOOL popoverOn = NO;
static NSWindowStyleMask savedStyle;
static NSRect savedFrame;
static NSSize savedMinSize;
static NSColor *savedBackground;
static NSWindowLevel savedLevel;
static NSWindowCollectionBehavior savedBehavior;
static id resignObserver;
static NSTimeInterval lastAutoHide;

static void onMain(dispatch_block_t block) {
	if ([NSThread isMainThread]) {
		block();
	} else {
		dispatch_sync(dispatch_get_main_queue(), block);
	}
}

static NSWindow *mainWindow(void) {
	Class cls = NSClassFromString(@"WailsWindow");
	for (NSWindow *w in [NSApp windows]) {
		if (cls && [w isKindOfClass:cls]) {
			return w;
		}
	}
	return nil;
}

// AppKit keeps each status item in its own NSStatusBarWindow; Tokify owns
// exactly one, so its frame is the item's position in the menu bar.
static NSRect statusItemFrame(void) {
	for (NSWindow *w in [NSApp windows]) {
		if (w.isVisible && [NSStringFromClass([w class]) isEqualToString:@"NSStatusBarWindow"]) {
			return w.frame;
		}
	}
	return NSZeroRect;
}

static int enterMenuBarMode(void) {
	__block int ok = 0;
	onMain(^{
		NSWindow *w = mainWindow();
		if (w == nil) {
			return;
		}
		if (popoverOn) {
			ok = 1;
			return;
		}
		if (w.styleMask & NSWindowStyleMaskFullScreen) {
			return;
		}
		savedStyle = w.styleMask;
		savedFrame = w.frame;
		savedMinSize = w.minSize;
		// cgo builds without ARC, so anything kept past this block is retained
		// by hand and released on the way out.
		savedBackground = [w.backgroundColor retain];
		savedLevel = w.level;
		savedBehavior = w.collectionBehavior;

		[w orderOut:nil];
		w.styleMask = NSWindowStyleMaskBorderless;
		w.opaque = NO;
		w.backgroundColor = [NSColor clearColor];
		w.hasShadow = YES;
		w.movable = NO;
		w.level = NSFloatingWindowLevel;
		w.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
			NSWindowCollectionBehaviorFullScreenAuxiliary;
		[w setMinSize:NSMakeSize(0, 0)];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

		resignObserver = [[[NSNotificationCenter defaultCenter]
			addObserverForName:NSWindowDidResignKeyNotification
			            object:w
			             queue:nil
			        usingBlock:^(NSNotification *note) {
				// Save panels and alerts take key while they're up; the popover
				// has to outlive them or they'd lose their parent.
				if (w.attachedSheet != nil || NSApp.modalWindow != nil) {
					return;
				}
				lastAutoHide = [NSDate timeIntervalSinceReferenceDate];
				[w orderOut:nil];
			}] retain];
		popoverOn = YES;
		ok = 1;
	});
	return ok;
}

static void exitMenuBarMode(void) {
	onMain(^{
		NSWindow *w = mainWindow();
		if (w == nil || !popoverOn) {
			return;
		}
		popoverOn = NO;
		[[NSNotificationCenter defaultCenter] removeObserver:resignObserver];
		[resignObserver release];
		resignObserver = nil;

		[w orderOut:nil];
		w.styleMask = savedStyle;
		w.opaque = YES;
		w.backgroundColor = savedBackground;
		[savedBackground release];
		savedBackground = nil;
		w.movable = YES;
		w.level = savedLevel;
		w.collectionBehavior = savedBehavior;
		[w setMinSize:savedMinSize];
		[w setFrame:savedFrame display:YES];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
		[NSApp activateIgnoringOtherApps:YES];
		[w makeKeyAndOrderFront:nil];
	});
}

// placePopover sizes the window and hangs it from the status item, clamped to
// the item's screen. It returns the item's centre in window points so the page
// can aim its tail at it, or -1 when the popover isn't active.
static double placePopover(double width, double height) {
	__block double tail = -1;
	onMain(^{
		NSWindow *w = mainWindow();
		if (w == nil || !popoverOn) {
			return;
		}
		NSRect item = statusItemFrame();
		NSScreen *screen = nil;
		if (NSIsEmptyRect(item)) {
			NSPoint mouse = [NSEvent mouseLocation];
			for (NSScreen *s in [NSScreen screens]) {
				if (NSPointInRect(mouse, s.frame)) {
					screen = s;
				}
			}
			if (screen == nil) {
				screen = [NSScreen mainScreen];
			}
			NSRect vis = screen.visibleFrame;
			item = NSMakeRect(mouse.x, NSMaxY(vis), 0, 0);
		} else {
			NSPoint mid = NSMakePoint(NSMidX(item), NSMidY(item));
			for (NSScreen *s in [NSScreen screens]) {
				if (NSPointInRect(mid, s.frame)) {
					screen = s;
				}
			}
			if (screen == nil) {
				screen = [NSScreen mainScreen];
			}
		}
		NSRect vis = screen.visibleFrame;
		CGFloat margin = 8;
		CGFloat x = NSMidX(item) - width / 2;
		x = MIN(x, NSMaxX(vis) - margin - width);
		x = MAX(x, NSMinX(vis) + margin);
		CGFloat top = MIN(NSMinY(item), NSMaxY(vis)) - 2;
		[w setFrame:NSMakeRect(x, top - height, width, height) display:NO];
		tail = NSMidX(item) - x;
	});
	return tail;
}

static void revealPopover(void) {
	onMain(^{
		NSWindow *w = mainWindow();
		if (w == nil || !popoverOn) {
			return;
		}
		[NSApp activateIgnoringOtherApps:YES];
		[w makeKeyAndOrderFront:nil];
		// The shadow follows the page's alpha, which only settles once WebKit
		// has painted the transparent corners and the tail.
		dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
			[w invalidateShadow];
		});
	});
}

static void hidePopover(void) {
	onMain(^{
		NSWindow *w = mainWindow();
		if (w != nil && popoverOn) {
			[w orderOut:nil];
		}
	});
}

// popoverState reports 1 when the popover is showing, and 2 when it hid itself
// a moment ago because this very click on the status item took focus away.
static int popoverState(void) {
	__block int state = 0;
	onMain(^{
		NSWindow *w = mainWindow();
		if (w != nil && popoverOn && w.isVisible) {
			state = 1;
		} else if ([NSDate timeIntervalSinceReferenceDate] - lastAutoHide < 0.3) {
			state = 2;
		}
	});
	return state;
}
*/
import "C"

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"fyne.io/systray"
	"github.com/go-faster/errors"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/kriuchkov/tock/internal/appdir"
)

// The popover's height includes the strip the tail hangs in.
const (
	popoverWidth  = 480
	popoverHeight = 620
)

type desktopPrefs struct {
	MenuBarMode bool `json:"menu_bar_mode"`
}

func desktopPrefsPath() (string, error) {
	return appdir.Path("desktop.json")
}

func loadDesktopPrefs() desktopPrefs {
	var prefs desktopPrefs
	p, err := desktopPrefsPath()
	if err != nil {
		return prefs
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return prefs
	}
	_ = json.Unmarshal(data, &prefs)
	return prefs
}

func saveDesktopPrefs(prefs desktopPrefs) error {
	p, err := desktopPrefsPath()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return errors.Wrap(err, "create settings dir")
	}
	data, err := json.Marshal(prefs)
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}

// MenuBarMode reports whether Tokify lives in a popover under its menu bar item
// instead of a regular window.
func (a *App) MenuBarMode() bool {
	return a.menuBar.Load()
}

// SetMenuBarMode switches between the regular window and the menu bar popover
// and remembers the choice for the next launch. Entering the mode opens the
// popover straight away so it's clear where the window went.
func (a *App) SetMenuBarMode(enabled bool) error {
	if enabled == a.menuBar.Load() {
		return nil
	}
	if enabled {
		wailsruntime.EventsEmit(a.ctx, "menubar:mode", true)
		if C.enterMenuBarMode() == 0 {
			wailsruntime.EventsEmit(a.ctx, "menubar:mode", false)
			return errors.New("leave full screen before switching to the menu bar")
		}
		a.menuBar.Store(true)
		systray.SetOnTapped(func() { go a.togglePopover() })
		a.showPopover()
	} else {
		a.menuBar.Store(false)
		systray.SetOnTapped(nil)
		C.exitMenuBarMode()
		wailsruntime.EventsEmit(a.ctx, "menubar:mode", false)
	}
	a.refreshTrayTitle()
	return saveDesktopPrefs(desktopPrefs{MenuBarMode: enabled})
}

// domReady reapplies a saved menu bar mode once the window exists. main sets
// the flag before launch so the page reads the right mode on first paint; the
// window starts hidden, so the popover then waits for a click on the item.
func (a *App) domReady(_ context.Context) {
	if !a.menuBar.Load() {
		return
	}
	if C.enterMenuBarMode() == 0 {
		a.menuBar.Store(false)
		wailsruntime.EventsEmit(a.ctx, "menubar:mode", false)
		wailsruntime.WindowShow(a.ctx)
		return
	}
	systray.SetOnTapped(func() { go a.togglePopover() })
	a.refreshTrayTitle()
}

func (a *App) showPopover() {
	tail := float64(C.placePopover(popoverWidth, popoverHeight))
	if tail < 0 {
		return
	}
	wailsruntime.EventsEmit(a.ctx, "menubar:tail", tail)
	C.revealPopover()
}

func (a *App) togglePopover() {
	switch C.popoverState() {
	case 1:
		C.hidePopover()
	case 2:
	default:
		a.showPopover()
	}
}

// showMain brings Tokify forward in whichever form it currently takes.
func (a *App) showMain() {
	if a.menuBar.Load() {
		a.showPopover()
		return
	}
	wailsruntime.WindowShow(a.ctx)
}
