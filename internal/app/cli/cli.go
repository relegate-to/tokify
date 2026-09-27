// Package cli provides Tokify's scriptable command-line interface.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/kriuchkov/tock/internal/app/logbook"
	"github.com/kriuchkov/tock/internal/app/runtime"
	appstorage "github.com/kriuchkov/tock/internal/app/storage"
	"github.com/kriuchkov/tock/internal/appdir"
	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync"
)

const rootHelp = `Tokify tracks time from the command line and the macOS app.

Usage:
  tokify [--database PATH] COMMAND [OPTIONS]

Commands:
  start       Start tracking an activity
  stop        Stop the running activity
  current     Show the running activity
  watch       Print its elapsed time (or stream it with --follow)
  continue    Start a recent activity again
  last        List recent activities
  add         Add a completed activity
  list        List activities in a date range
  edit        Edit an activity by its start time
  remove      Delete an activity by its start time
  version     Print the installed version
  help        Show this help

Run "tokify COMMAND --help" for command-specific help.

Environment:
  TOKIFY_DATABASE overrides the SQLite database path.
  TOKIFY_PROFILE selects the same isolated profile as the desktop app.
`

type Options struct {
	Stdout io.Writer
	Stderr io.Writer
	Now    func() time.Time
}

type runner struct {
	stdout  io.Writer
	stderr  io.Writer
	now     func() time.Time
	dbPath  string
	runtime *runtime.Runtime
	logbook *logbook.Logbook
}

func Run(ctx context.Context, args []string, options Options) int {
	r := newRunner(options)
	if err := r.run(ctx, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(r.stderr, "tokify: %v\n", err)
		return 1
	}
	return 0
}

func newRunner(options Options) *runner {
	if options.Stdout == nil {
		options.Stdout = io.Discard
	}
	if options.Stderr == nil {
		options.Stderr = io.Discard
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &runner{stdout: options.Stdout, stderr: options.Stderr, now: options.Now}
}

func (r *runner) run(ctx context.Context, args []string) error {
	root := flag.NewFlagSet("tokify", flag.ContinueOnError)
	root.SetOutput(r.stderr)
	root.StringVar(&r.dbPath, "database", strings.TrimSpace(os.Getenv("TOKIFY_DATABASE")), "SQLite database path")
	root.StringVar(&r.dbPath, "db", strings.TrimSpace(os.Getenv("TOKIFY_DATABASE")), "SQLite database path (shorthand)")
	root.Usage = func() { fmt.Fprint(root.Output(), rootHelp) }

	commandAt := firstCommandIndex(args)
	if commandAt < 0 {
		if err := root.Parse(args); err != nil {
			return err
		}
		fmt.Fprint(r.stdout, rootHelp)
		return nil
	}
	if err := root.Parse(args[:commandAt]); err != nil {
		return err
	}

	command := args[commandAt]
	commandArgs := args[commandAt+1:]
	if command == "help" || command == "-h" || command == "--help" {
		return r.runHelp(commandArgs)
	}
	if command == "version" {
		fmt.Fprintln(r.stdout, version())
		return nil
	}

	switch command {
	case "start":
		return r.runStart(ctx, commandArgs)
	case "stop", "s":
		return r.runStop(ctx, commandArgs)
	case "current", "status":
		return r.runCurrent(ctx, commandArgs)
	case "watch":
		return r.runWatch(ctx, commandArgs)
	case "continue", "c":
		return r.runContinue(ctx, commandArgs)
	case "last", "lt":
		return r.runLast(ctx, commandArgs)
	case "add":
		return r.runAdd(ctx, commandArgs)
	case "list", "ls":
		return r.runList(ctx, commandArgs)
	case "edit":
		return r.runEdit(ctx, commandArgs)
	case "remove", "rm":
		return r.runRemove(ctx, commandArgs)
	default:
		return fmt.Errorf("unknown command %q; run tokify help", command)
	}
}

func (r *runner) runHelp(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(r.stdout, rootHelp)
		return nil
	}
	if len(args) > 1 {
		return errors.New("help accepts at most one command")
	}
	help, ok := commandHelp(args[0])
	if !ok {
		return fmt.Errorf("unknown command %q", args[0])
	}
	fmt.Fprint(r.stdout, help)
	return nil
}

func (r *runner) ensureRuntime(ctx context.Context) error {
	if r.runtime != nil {
		return nil
	}
	return r.loadRuntime(ctx)
}

func (r *runner) activityLogbook(ctx context.Context) (*logbook.Logbook, error) {
	if err := r.ensureRuntime(ctx); err != nil {
		return nil, err
	}
	if r.logbook != nil {
		return r.logbook, nil
	}
	var deletions logbook.DeletionRecorder
	if r.dbPath == "" {
		syncService, err := neonsync.NewService(r.runtime.ActivityService, nil)
		if err != nil {
			return nil, fmt.Errorf("load sync deletion log: %w", err)
		}
		deletions = syncService
	}
	r.logbook = logbook.New(r.runtime.ActivityRepo, deletions, nil)
	return r.logbook, nil
}

func (r *runner) loadRuntime(ctx context.Context) error {
	dbPath := r.dbPath
	if dbPath == "" {
		dbPath = appdir.DatabasePath()
	}
	loaded, err := runtime.Load(ctx, dbPath)
	if err != nil {
		return fmt.Errorf("open activity database: %w", err)
	}
	r.runtime = loaded

	if r.dbPath != "" {
		return nil
	}
	importer, ok := loaded.ActivityRepo.(interface {
		ImportOnce(context.Context, string, []models.Activity) (int, error)
	})
	if !ok {
		return nil
	}
	if _, err = appstorage.MigrateLegacyTextLog(ctx, appdir.LogPath(), importer); err != nil {
		return fmt.Errorf("import legacy activity log: %w", err)
	}
	return nil
}

func firstCommandIndex(args []string) int {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--database" || arg == "--db" {
			i++
			continue
		}
		if strings.HasPrefix(arg, "--database=") || strings.HasPrefix(arg, "--db=") {
			continue
		}
		return i
	}
	return -1
}

func version() string {
	info, ok := debug.ReadBuildInfo()
	if !ok || info.Main.Version == "" || info.Main.Version == "(devel)" {
		return "dev"
	}
	return info.Main.Version
}

func newFlagSet(name, usage string, output io.Writer) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(output)
	flags.Usage = func() { fmt.Fprint(flags.Output(), usage) }
	return flags
}

func commandHelp(command string) (string, bool) {
	switch command {
	case "start":
		return startHelp, true
	case "stop":
		return stopHelp, true
	case "current":
		return currentHelp, true
	case "watch":
		return watchHelp, true
	case "continue":
		return continueHelp, true
	case "last":
		return lastHelp, true
	case "add":
		return addHelp, true
	case "list":
		return listHelp, true
	case "edit":
		return editHelp, true
	case "remove":
		return removeHelp, true
	default:
		return "", false
	}
}
