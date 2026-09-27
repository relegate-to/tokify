package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	_ "github.com/doug-martin/goqu/v9/dialect/sqlite3" // register the goqu sqlite3 dialect
	_ "github.com/mattn/go-sqlite3"                    // register the sqlite3 database driver

	"github.com/kriuchkov/tock/internal/app/cli"
)

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return cli.Run(ctx, os.Args[1:], cli.Options{
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	})
}
