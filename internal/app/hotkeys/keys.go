package hotkeys

import "strings"

// macKeyCodes maps KeyboardEvent.code values to macOS virtual key codes
// (Carbon's kVK_* constants, from HIToolbox/Events.h). Both name physical
// keys, so a shortcut stays on the same key whatever the keyboard layout.
var macKeyCodes = map[string]uint32{ //nolint:gochecknoglobals // a fixed lookup table.
	"KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05,
	"KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "KeyB": 0x0B, "KeyQ": 0x0C,
	"KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11, "KeyO": 0x1F,
	"KeyU": 0x20, "KeyI": 0x22, "KeyP": 0x23, "KeyL": 0x25, "KeyJ": 0x26, "KeyK": 0x28,
	"KeyN": 0x2D, "KeyM": 0x2E,
	"Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit5": 0x17,
	"Digit6": 0x16, "Digit7": 0x1A, "Digit8": 0x1C, "Digit9": 0x19, "Digit0": 0x1D,
	"Equal": 0x18, "Minus": 0x1B, "BracketRight": 0x1E, "BracketLeft": 0x21, "Quote": 0x27,
	"Semicolon": 0x29, "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C, "Period": 0x2F, "Backquote": 0x32,
	"Enter": 0x24, "Tab": 0x30, "Space": 0x31, "Backspace": 0x33, "Escape": 0x35,
	"Delete": 0x75, "Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79,
	"ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
	"F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61, "F7": 0x62,
	"F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F, "F13": 0x69,
	"F14": 0x6B, "F15": 0x71, "F16": 0x6A, "F17": 0x40, "F18": 0x4F, "F19": 0x50,
}

// MacKeyCode returns the macOS virtual key code for a KeyboardEvent.code.
func MacKeyCode(code string) (uint32, bool) {
	k, ok := macKeyCodes[code]
	return k, ok
}

// keyLabel is a key's name as a menu shows it.
func keyLabel(code string) string {
	switch {
	case strings.HasPrefix(code, "Key"):
		return code[3:]
	case strings.HasPrefix(code, "Digit"):
		return code[5:]
	}
	if label, ok := map[string]string{
		"Space": "Space", "Enter": "↩", "Tab": "⇥", "Backspace": "⌫", "Escape": "⎋", "Delete": "⌦",
		"ArrowLeft": "←", "ArrowRight": "→", "ArrowUp": "↑", "ArrowDown": "↓",
		"Home": "↖", "End": "↘", "PageUp": "⇞", "PageDown": "⇟",
		"Equal": "=", "Minus": "-", "BracketLeft": "[", "BracketRight": "]", "Quote": "'",
		"Semicolon": ";", "Backslash": "\\", "Comma": ",", "Slash": "/", "Period": ".", "Backquote": "`",
	}[code]; ok {
		return label
	}
	return code
}
