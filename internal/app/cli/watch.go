package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"syscall"
	"text/template"
	"time"

	"github.com/kriuchkov/tock/internal/core/models"
)

const watchHelp = `Print the elapsed time of the running activity.

With no options, watch prints one HH:MM:SS value and exits, which is useful for
status bars and desktop widgets that poll a command. Use --follow to stream an
updated line at an interval until interrupted.

Usage:
  tokify watch [OPTIONS]

Options:
  -f, --follow           Keep printing updates
  -n, --interval TIME    Update interval in follow mode (default 1s)
  -F, --format TEMPLATE  Go template using Project, Description, Start,
                         Duration, ElapsedSeconds, and Running
      --idle TEXT        Text to print when nothing is running (default empty)
      --json             Print one JSON object per update
`

type status struct {
	Running        bool   `json:"running"`
	Project        string `json:"project,omitempty"`
	Description    string `json:"description,omitempty"`
	Start          string `json:"start,omitempty"`
	Duration       string `json:"duration"`
	ElapsedSeconds int64  `json:"elapsed_seconds"`
}

type watchOptions struct {
	follow     bool
	interval   time.Duration
	format     string
	idle       string
	jsonOutput bool
}

func (r *runner) runWatch(ctx context.Context, args []string) error {
	options := watchOptions{interval: time.Second}
	flags := newFlagSet("watch", watchHelp, r.stderr)
	boolFlag(flags, &options.follow, "follow", "f", false, "Keep printing updates")
	durationFlag(flags, &options.interval, "interval", "n", time.Second, "Update interval")
	stringFlag(flags, &options.format, "format", "F", "", "Output template")
	flags.StringVar(&options.idle, "idle", "", "Idle text")
	flags.BoolVar(&options.jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("watch does not accept positional arguments")
	}
	if options.interval <= 0 {
		return errors.New("interval must be greater than zero")
	}
	if err := r.ensureRuntime(ctx); err != nil {
		return err
	}

	if err := r.writeWatchStatus(ctx, options); err != nil {
		return ignoreBrokenPipe(err)
	}
	if !options.follow {
		return nil
	}

	ticker := time.NewTicker(options.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.writeWatchStatus(ctx, options); err != nil {
				return ignoreBrokenPipe(err)
			}
		}
	}
}

func (r *runner) writeWatchStatus(ctx context.Context, options watchOptions) error {
	current, err := r.currentStatus(ctx, r.now())
	if err != nil {
		return err
	}
	if options.jsonOutput {
		return writeJSON(r.stdout, current)
	}
	if options.format != "" {
		return writeStatusTemplate(r.stdout, options.format, current)
	}
	if current.Running {
		_, err = fmt.Fprintln(r.stdout, current.Duration)
		return err
	}
	if options.idle != "" {
		_, err = fmt.Fprintln(r.stdout, options.idle)
	} else if options.follow {
		// A blank update lets streaming consumers clear the last running value.
		_, err = fmt.Fprintln(r.stdout)
	}
	return err
}

func (r *runner) currentStatus(ctx context.Context, now time.Time) (status, error) {
	running := true
	activities, err := r.runtime.ActivityService.List(ctx, models.ActivityFilter{IsRunning: &running})
	if err != nil {
		return status{}, fmt.Errorf("load current activity: %w", err)
	}
	if len(activities) == 0 {
		return status{Duration: "00:00:00"}, nil
	}
	latest := activities[len(activities)-1]
	elapsed := now.Sub(latest.StartTime)
	if elapsed < 0 {
		elapsed = 0
	}
	elapsed = elapsed.Round(time.Second)
	return status{
		Running:        true,
		Project:        latest.Project,
		Description:    latest.Description,
		Start:          latest.StartTime.Local().Format(time.RFC3339),
		Duration:       formatDuration(elapsed),
		ElapsedSeconds: int64(elapsed / time.Second),
	}, nil
}

func writeStatusTemplate(output io.Writer, source string, value status) error {
	parsed, err := template.New("status").Option("missingkey=error").Parse(source)
	if err != nil {
		return fmt.Errorf("parse output format: %w", err)
	}
	if err = parsed.Execute(output, value); err != nil {
		return fmt.Errorf("render output format: %w", err)
	}
	if !strings.HasSuffix(source, "\n") {
		_, err = fmt.Fprintln(output)
	}
	return err
}

func ignoreBrokenPipe(err error) error {
	if errors.Is(err, syscall.EPIPE) {
		return nil
	}
	return err
}

func boolFlag(flags *flag.FlagSet, target *bool, name, short string, value bool, usage string) {
	flags.BoolVar(target, name, value, usage)
	flags.BoolVar(target, short, value, usage+" (shorthand)")
}

func durationFlag(flags *flag.FlagSet, target *time.Duration, name, short string, value time.Duration, usage string) {
	flags.DurationVar(target, name, value, usage)
	flags.DurationVar(target, short, value, usage+" (shorthand)")
}
