package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	coreErrors "github.com/kriuchkov/tock/internal/core/errors"
	"github.com/kriuchkov/tock/internal/core/models"
)

const startHelp = `Start tracking an activity.

Usage:
  tokify start [OPTIONS] [PROJECT] [DESCRIPTION]

Options:
  -p, --project NAME       Project name
  -d, --description TEXT  What you are working on
  -t, --time TIME          Start at HH:MM or YYYY-MM-DD HH:MM
      --note TEXT          Initial activity notes
      --tags LIST          Comma-separated tags
      --json               Print the activity as JSON
`

type startOptions struct {
	project     string
	description string
	at          string
	notes       string
	tags        string
	jsonOutput  bool
}

func (r *runner) runStart(ctx context.Context, args []string) error {
	options := startOptions{}
	flags := newFlagSet("start", startHelp, r.stderr)
	stringFlag(flags, &options.project, "project", "p", "", "Project name")
	stringFlag(flags, &options.description, "description", "d", "", "Activity description")
	stringFlag(flags, &options.at, "time", "t", "", "Start time")
	flags.StringVar(&options.notes, "note", "", "Initial activity notes")
	flags.StringVar(&options.tags, "tags", "", "Comma-separated tags")
	flags.BoolVar(&options.jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}

	positional := flags.Args()
	if options.project == "" && len(positional) > 0 {
		options.project = positional[0]
	}
	if options.description == "" && len(positional) > 1 {
		options.description = strings.Join(positional[1:], " ")
	}
	if strings.TrimSpace(options.project) == "" || strings.TrimSpace(options.description) == "" {
		return errors.New("project and description are required")
	}
	if err := r.ensureRuntime(ctx); err != nil {
		return err
	}
	return r.startWithOptions(ctx, options)
}

const stopHelp = `Stop the currently running activity.

Usage:
  tokify stop [OPTIONS]

Options:
  -t, --time TIME  Stop at HH:MM or YYYY-MM-DD HH:MM
      --note TEXT  Replace the activity notes
      --tags LIST  Replace tags with a comma-separated list
      --json       Print the activity as JSON
`

func (r *runner) runStop(ctx context.Context, args []string) error {
	flags := newFlagSet("stop", stopHelp, r.stderr)
	var at, notes, tags string
	var jsonOutput bool
	stringFlag(flags, &at, "time", "t", "", "Stop time")
	flags.StringVar(&notes, "note", "", "Activity notes")
	flags.StringVar(&tags, "tags", "", "Comma-separated tags")
	flags.BoolVar(&jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("stop does not accept positional arguments")
	}
	if err := r.ensureRuntime(ctx); err != nil {
		return err
	}
	end, err := parseDateTime(at, r.now())
	if err != nil {
		return fmt.Errorf("parse stop time: %w", err)
	}
	activity, err := r.runtime.ActivityService.Stop(ctx, models.StopActivityRequest{
		EndTime: end,
		Notes:   notes,
		Tags:    splitTags(tags),
	})
	if err != nil {
		if errors.Is(err, coreErrors.ErrNoActiveActivity) {
			return errors.New("no activity is running")
		}
		return fmt.Errorf("stop activity: %w", err)
	}
	if jsonOutput {
		return writeJSON(r.stdout, activity)
	}
	fmt.Fprintf(r.stdout, "Stopped %s · %s (%s)\n", activity.Project, activity.Description, formatDuration(activity.Duration()))
	return nil
}

const currentHelp = `Show the currently running activity.

Usage:
  tokify current [OPTIONS]

Options:
  -F, --format TEMPLATE  Go template using Project, Description, Start,
                         Duration, ElapsedSeconds, and Running
      --json             Print machine-readable JSON
`

func (r *runner) runCurrent(ctx context.Context, args []string) error {
	flags := newFlagSet("current", currentHelp, r.stderr)
	var format string
	var jsonOutput bool
	stringFlag(flags, &format, "format", "F", "", "Output template")
	flags.BoolVar(&jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("current does not accept positional arguments")
	}
	if err := r.ensureRuntime(ctx); err != nil {
		return err
	}
	status, err := r.currentStatus(ctx, r.now())
	if err != nil {
		return err
	}
	if jsonOutput {
		return writeJSON(r.stdout, status)
	}
	if format != "" {
		return writeStatusTemplate(r.stdout, format, status)
	}
	if !status.Running {
		fmt.Fprintln(r.stdout, "No activity is running.")
		return nil
	}
	fmt.Fprintf(r.stdout, "%s  %s · %s  since %s\n", status.Duration, status.Project, status.Description, status.Start)
	return nil
}

const continueHelp = `Start a recent activity again.

Usage:
  tokify continue [OPTIONS] [INDEX]

INDEX is zero-based and matches "tokify last" (default 0).

Options:
  -p, --project NAME       Override the project
  -d, --description TEXT  Override the description
  -t, --time TIME          Start at HH:MM or YYYY-MM-DD HH:MM
      --note TEXT          Initial activity notes
      --tags LIST          Comma-separated tags
      --json               Print the activity as JSON
`

func (r *runner) runContinue(ctx context.Context, args []string) error {
	options := startOptions{}
	flags := newFlagSet("continue", continueHelp, r.stderr)
	stringFlag(flags, &options.project, "project", "p", "", "Project override")
	stringFlag(flags, &options.description, "description", "d", "", "Description override")
	stringFlag(flags, &options.at, "time", "t", "", "Start time")
	flags.StringVar(&options.notes, "note", "", "Initial activity notes")
	flags.StringVar(&options.tags, "tags", "", "Comma-separated tags")
	flags.BoolVar(&options.jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	index, err := parseIndex(flags.Args())
	if err != nil {
		return err
	}
	if err = r.ensureRuntime(ctx); err != nil {
		return err
	}
	recent, err := r.runtime.ActivityService.GetRecent(ctx, index+1)
	if err != nil {
		return fmt.Errorf("list recent activities: %w", err)
	}
	if index >= len(recent) {
		return fmt.Errorf("recent activity %d not found", index)
	}
	selected := recent[index]
	if options.project == "" {
		options.project = selected.Project
	}
	if options.description == "" {
		options.description = selected.Description
	}
	return r.startWithOptions(ctx, options)
}

func (r *runner) startWithOptions(ctx context.Context, options startOptions) error {
	start, err := parseDateTime(options.at, r.now())
	if err != nil {
		return fmt.Errorf("parse start time: %w", err)
	}
	activity, err := r.runtime.ActivityService.Start(ctx, models.StartActivityRequest{
		Project:     strings.TrimSpace(options.project),
		Description: strings.TrimSpace(options.description),
		StartTime:   start,
		Notes:       options.notes,
		Tags:        splitTags(options.tags),
	})
	if err != nil {
		return fmt.Errorf("start activity: %w", err)
	}
	if options.jsonOutput {
		return writeJSON(r.stdout, activity)
	}
	fmt.Fprintf(r.stdout, "Started %s · %s at %s\n", activity.Project, activity.Description, activity.StartTime.Format("15:04"))
	return nil
}

const lastHelp = `List recent unique activities.

Usage:
  tokify last [OPTIONS]

Options:
  -n, --number COUNT  Number to list (default 10)
      --json          Print machine-readable JSON
`

func (r *runner) runLast(ctx context.Context, args []string) error {
	flags := newFlagSet("last", lastHelp, r.stderr)
	var limit int
	var jsonOutput bool
	intFlag(flags, &limit, "number", "n", 10, "Number of activities")
	flags.BoolVar(&jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if limit < 1 {
		return errors.New("number must be at least 1")
	}
	if err := r.ensureRuntime(ctx); err != nil {
		return err
	}
	activities, err := r.runtime.ActivityService.GetRecent(ctx, limit)
	if err != nil {
		return fmt.Errorf("list recent activities: %w", err)
	}
	if jsonOutput {
		return writeJSON(r.stdout, activities)
	}
	if len(activities) == 0 {
		fmt.Fprintln(r.stdout, "No activities yet.")
		return nil
	}
	w := tabwriter.NewWriter(r.stdout, 0, 0, 2, ' ', 0)
	for i, activity := range activities {
		fmt.Fprintf(w, "[%d]\t%s\t%s\n", i, activity.Project, activity.Description)
	}
	return w.Flush()
}

func parseIndex(args []string) (int, error) {
	if len(args) > 1 {
		return 0, errors.New("continue accepts at most one index")
	}
	if len(args) == 0 {
		return 0, nil
	}
	index, err := strconv.Atoi(args[0])
	if err != nil || index < 0 {
		return 0, fmt.Errorf("invalid activity index %q", args[0])
	}
	return index, nil
}

func parseDateTime(input string, now time.Time) (time.Time, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return now, nil
	}
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02T15:04", time.RFC3339} {
		if parsed, err := time.ParseInLocation(layout, input, now.Location()); err == nil {
			return parsed, nil
		}
	}
	parsed, err := time.ParseInLocation("15:04", input, now.Location())
	if err != nil {
		return time.Time{}, errors.New("use HH:MM, YYYY-MM-DD HH:MM, or RFC 3339")
	}
	return time.Date(now.Year(), now.Month(), now.Day(), parsed.Hour(), parsed.Minute(), 0, 0, now.Location()), nil
}

func splitTags(value string) []string {
	var tags []string
	for tag := range strings.SplitSeq(value, ",") {
		if tag = strings.TrimSpace(tag); tag != "" && !slices.Contains(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func stringFlag(flags *flag.FlagSet, target *string, name, short, value, usage string) {
	flags.StringVar(target, name, value, usage)
	flags.StringVar(target, short, value, usage+" (shorthand)")
}

func intFlag(flags *flag.FlagSet, target *int, name, short string, value int, usage string) {
	flags.IntVar(target, name, value, usage)
	flags.IntVar(target, short, value, usage+" (shorthand)")
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func formatDuration(duration time.Duration) string {
	if duration < 0 {
		duration = 0
	}
	total := int64(duration.Round(time.Second) / time.Second)
	hours := total / 3600
	minutes := total % 3600 / 60
	seconds := total % 60
	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
}
