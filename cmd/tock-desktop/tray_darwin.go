//go:build darwin && !bindings

package main

import "fyne.io/systray"

func trayExternalLoop(app *App) (start func(), end func()) {
	return systray.RunWithExternalLoop(app.trayOnReady, app.trayOnExit)
}
