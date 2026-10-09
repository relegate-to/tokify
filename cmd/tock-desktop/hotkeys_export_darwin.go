//go:build darwin

package main

import "C"

// tokifyHotKeyPressed is Carbon's way back into Go. It lives apart from
// hotkeys_darwin.go because a file with //export may only declare, not
// define, C in its preamble.
//
//export tokifyHotKeyPressed
func tokifyHotKeyPressed(id C.uint) {
	hotKeyPressed(uint32(id))
}
