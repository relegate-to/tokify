package hotkeys

import (
	"errors"
	"testing"
)

func TestDefaultsAreValid(t *testing.T) {
	if err := Validate(Defaults()); err != nil {
		t.Fatalf("defaults: %v", err)
	}
}

func TestValidateRejectsBadSets(t *testing.T) {
	cmdT := Shortcut{Key: "KeyT", Cmd: true}
	cases := map[string][]Binding{
		"unknown action": {{Action: "launch-rocket", Shortcut: cmdT}},
		"action twice": {
			{Action: ToggleTimer, Shortcut: cmdT},
			{Action: ToggleTimer, Shortcut: Shortcut{Key: "KeyY", Cmd: true}},
		},
		"shortcut twice": {
			{Action: ToggleTimer, Shortcut: cmdT},
			{Action: StopTimer, Shortcut: cmdT},
		},
		"unsupported key": {{Action: ToggleTimer, Shortcut: Shortcut{Key: "IntlYen", Cmd: true}}},
		"global without modifier": {
			{Action: ToggleTimer, Shortcut: Shortcut{Key: "KeyT"}, Global: true},
		},
	}
	for name, set := range cases {
		if err := Validate(set); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: got %v, want ErrInvalid", name, err)
		}
	}
}

func TestValidateAllowsBareKeysInsideAndFunctionKeysEverywhere(t *testing.T) {
	set := []Binding{
		{Action: ViewNotes, Shortcut: Shortcut{Key: "KeyN"}},
		{Action: ToggleTimer, Shortcut: Shortcut{Key: "F5"}, Global: true},
	}
	if err := Validate(set); err != nil {
		t.Fatal(err)
	}
}

func TestShortcutString(t *testing.T) {
	cases := map[string]Shortcut{
		"⌃⌥⌘T":    {Key: "KeyT", Ctrl: true, Alt: true, Cmd: true},
		"⇧⌘1":     {Key: "Digit1", Shift: true, Cmd: true},
		"⌘,":      {Key: "Comma", Cmd: true},
		"⌃⌥Space": {Key: "Space", Ctrl: true, Alt: true},
		"F5":      {Key: "F5"},
	}
	for want, s := range cases {
		if got := s.String(); got != want {
			t.Errorf("%+v = %q, want %q", s, got, want)
		}
	}
}

func TestMacKeyCodes(t *testing.T) {
	for code, want := range map[string]uint32{"KeyT": 0x11, "Space": 0x31, "Digit1": 0x12, "F5": 0x60} {
		if got, ok := MacKeyCode(code); !ok || got != want {
			t.Errorf("%s = %#x, %v; want %#x", code, got, ok, want)
		}
	}
}
