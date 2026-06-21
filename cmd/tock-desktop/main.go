package main

import (
	"embed"

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

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "Toki",
		Width:     760,
		Height:    760,
		MinWidth:  520,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 229, G: 232, B: 226, A: 1}, // matches --paper
		OnStartup:        app.startup,
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(), // inset traffic lights, no title text
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
