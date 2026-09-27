//go:build darwin && bindings

package main

// Binding generation executes the app's main function. Starting the macOS tray
// loop there exits before Wails can inspect App, so keep that build headless.
func trayExternalLoop(_ *App) (start func(), end func()) {
	return func() {}, func() {}
}
