// Package hotkeys holds Tokify's configurable keyboard shortcuts: the actions
// a key can be bound to, the bindings themselves, and the rules a set of
// bindings must follow. A binding fires inside the window, or anywhere on the
// Mac when it is global; registering global ones is the desktop app's job.
package hotkeys

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Action is a thing a shortcut can do.
type Action string

const (
	ToggleTimer  Action = "toggle-timer"
	StopTimer    Action = "stop-timer"
	ResumeLast   Action = "resume-last"
	NewActivity  Action = "new-activity"
	ShowTokify   Action = "show-tokify"
	ViewNow      Action = "view-now"
	ViewLog      Action = "view-log"
	ViewNotes    Action = "view-sketchpad"
	ViewReports  Action = "view-reports"
	ViewCharts   Action = "view-charts"
	ViewStats    Action = "view-stats"
	OpenSettings Action = "open-settings"
)

// Actions lists every bindable action, in the order Settings shows them.
func Actions() []Action {
	return []Action{
		ToggleTimer, StopTimer, ResumeLast, NewActivity, ShowTokify,
		ViewNow, ViewLog, ViewNotes, ViewReports, ViewCharts, ViewStats, OpenSettings,
	}
}

// Known reports whether a is a bindable action.
func Known(a Action) bool {
	return slices.Contains(Actions(), a)
}

// Shortcut is a key plus modifiers. Key is the browser's KeyboardEvent.code
// (the physical key, so "KeyT" whatever the layout types there).
type Shortcut struct {
	Key   string `json:"key"`
	Cmd   bool   `json:"cmd,omitempty"`
	Ctrl  bool   `json:"ctrl,omitempty"`
	Alt   bool   `json:"alt,omitempty"`
	Shift bool   `json:"shift,omitempty"`
}

// HasModifier reports whether any modifier is held.
func (s Shortcut) HasModifier() bool {
	return s.Cmd || s.Ctrl || s.Alt || s.Shift
}

// String renders the shortcut the way macOS menus do, e.g. "⌃⌥⌘T".
func (s Shortcut) String() string {
	var b strings.Builder
	for _, m := range []struct {
		on    bool
		glyph string
	}{{s.Ctrl, "⌃"}, {s.Alt, "⌥"}, {s.Shift, "⇧"}, {s.Cmd, "⌘"}} {
		if m.on {
			b.WriteString(m.glyph)
		}
	}
	b.WriteString(keyLabel(s.Key))
	return b.String()
}

func (s Shortcut) same(o Shortcut) bool {
	return s == o
}

// Binding attaches a shortcut to an action. A global binding works from any
// app; otherwise it only works while Tokify's window has focus.
type Binding struct {
	Action   Action   `json:"action"`
	Shortcut Shortcut `json:"shortcut"`
	Global   bool     `json:"global,omitempty"`
}

// Defaults are the bindings a fresh install starts with: the window's own
// view shortcuts, plus a global start/stop and show that are unlikely to
// clash with other apps.
func Defaults() []Binding {
	return []Binding{
		{Action: ToggleTimer, Shortcut: Shortcut{Key: "KeyT", Ctrl: true, Alt: true, Cmd: true}, Global: true},
		{Action: ShowTokify, Shortcut: Shortcut{Key: "Space", Ctrl: true, Alt: true, Cmd: true}, Global: true},
		{Action: ViewNow, Shortcut: Shortcut{Key: "Digit1", Cmd: true}},
		{Action: ViewLog, Shortcut: Shortcut{Key: "Digit2", Cmd: true}},
		{Action: OpenSettings, Shortcut: Shortcut{Key: "Comma", Cmd: true}},
	}
}

// ErrInvalid wraps every validation failure.
var ErrInvalid = errors.New("invalid shortcut")

// Validate checks a full set of bindings: known actions and keys, one
// shortcut per action, no shortcut used twice, and a modifier on every global
// shortcut except the function keys, so a global binding can never swallow
// ordinary typing in other apps.
func Validate(bindings []Binding) error {
	seenAction := map[Action]bool{}
	for i, b := range bindings {
		if !Known(b.Action) {
			return fmt.Errorf("%w: unknown action %q", ErrInvalid, b.Action)
		}
		if seenAction[b.Action] {
			return fmt.Errorf("%w: %s is bound twice", ErrInvalid, b.Action)
		}
		seenAction[b.Action] = true
		if _, ok := MacKeyCode(b.Shortcut.Key); !ok {
			return fmt.Errorf("%w: unsupported key %q", ErrInvalid, b.Shortcut.Key)
		}
		if b.Global && !b.Shortcut.HasModifier() && !isFunctionKey(b.Shortcut.Key) {
			return fmt.Errorf("%w: %s needs a modifier to work everywhere", ErrInvalid, b.Shortcut)
		}
		for _, o := range bindings[:i] {
			if o.Shortcut.same(b.Shortcut) {
				return fmt.Errorf("%w: %s is used for both %s and %s", ErrInvalid, b.Shortcut, o.Action, b.Action)
			}
		}
	}
	return nil
}

func isFunctionKey(code string) bool {
	return len(code) >= 2 && code[0] == 'F' && code[1] >= '1' && code[1] <= '9'
}
