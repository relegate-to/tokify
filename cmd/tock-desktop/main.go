//go:build darwin

package main

import (
	"embed"

	"fyne.io/systray"
	_ "github.com/doug-martin/goqu/v9/dialect/sqlite3" // register goqu sqlite3 dialect for the sqlite backend
	_ "github.com/mattn/go-sqlite3"                    // register the sqlite3 database driver

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// The tray runs alongside Wails' Cocoa loop via RunWithExternalLoop: start()
	// schedules the NSStatusItem setup onto the main thread, then wails.Run owns
	// the loop until the user quits.
	trayStart, trayEnd := systray.RunWithExternalLoop(app.trayOnReady, app.trayOnExit)
	trayStart()

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "Tokify",
		Width:     760,
		Height:    760,
		MinWidth:  520,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour:  &options.RGBA{R: 229, G: 232, B: 226, A: 1}, // matches --paper
		OnStartup:         app.startup,
		HideWindowOnClose: true, // red traffic light hides; tray's Quit / Cmd+Q actually quit.
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(), // inset traffic lights, no title text
		},
		Bind: []interface{}{
			app,
		},
	})

	trayEnd()

	if err != nil {
		println("Error:", err.Error())
	}
}
