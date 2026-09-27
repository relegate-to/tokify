package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/kriuchkov/tock/internal/app/logbook"
)

const addHelp = `Add a completed activity.

Usage:
  tokify add [OPTIONS] [PROJECT] [DESCRIPTION]

Options:
  -p, --project NAME       Project name
  -d, --description TEXT  What was worked on
  -s, --start TIME         Start (required)
  -e, --end TIME           End; required unless --duration is used
      --duration TIME      Go duration such as 45m or 1h30m
      --note TEXT          Activity notes
      --json               Print the entry as JSON
`

type addOptions struct {
	project     string
	description string
	start       string
	end         string
	duration    time.Duration
	notes       string
	jsonOutput  bool
}

func (r *runner) runAdd(ctx context.Context, args []string) error {
	options := addOptions{}
	flags := newFlagSet("add", addHelp, r.stderr)
	stringFlag(flags, &options.project, "project", "p", "Project name")
	stringFlag(flags, &options.description, "description", "d", "Activity description")
	stringFlag(flags, &options.start, "start", "s", "Start time")
	stringFlag(flags, &options.end, "end", "e", "End time")
	flags.DurationVar(&options.duration, "duration", 0, "Activity duration")
	flags.StringVar(&options.notes, "note", "", "Activity notes")
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
	if options.start == "" {
		return errors.New("start is required")
	}
	if options.end == "" && options.duration <= 0 {
		return errors.New("end or a positive duration is required")
	}
	if options.end != "" && options.duration != 0 {
		return errors.New("end and duration cannot be used together")
	}
	start, err := parseDateTime(options.start, r.now())
	if err != nil {
		return fmt.Errorf("parse start time: %w", err)
	}
	end := start.Add(options.duration)
	if options.end != "" {
		end, err = parseDateTime(options.end, r.now())
		if err != nil {
			return fmt.Errorf("parse end time: %w", err)
		}
	}
	book, err := r.activityLogbook(ctx)
	if err != nil {
		return err
	}
	entry, err := book.Add(ctx, logbook.AddRequest{
		Project:     options.project,
		Description: options.description,
		Start:       start,
		End:         end,
		Notes:       options.notes,
	})
	if err != nil {
		return fmt.Errorf("add activity: %w", err)
	}
	return r.writeEntry(entry, options.jsonOutput, "Added")
}

const listHelp = `List activities, oldest first.

With no range flags, list shows today. A date includes that complete local day.

Usage:
  tokify list [OPTIONS]

Options:
      --date YYYY-MM-DD  One local day
      --from TIME        Range start (requires --to)
      --to TIME          Range end, exclusive (requires --from)
  -p, --project NAME     Exact project filter
      --json             Print entries and total minutes as JSON
`

type listOptions struct {
	date       string
	from       string
	to         string
	project    string
	jsonOutput bool
}

type listOutput struct {
	Entries      []logbook.Entry `json:"entries"`
	TotalMinutes int             `json:"total_minutes"`
}

func (r *runner) runList(ctx context.Context, args []string) error {
	options := listOptions{}
	flags := newFlagSet("list", listHelp, r.stderr)
	flags.StringVar(&options.date, "date", "", "One local day")
	flags.StringVar(&options.from, "from", "", "Range start")
	flags.StringVar(&options.to, "to", "", "Range end")
	stringFlag(flags, &options.project, "project", "p", "Project filter")
	flags.BoolVar(&options.jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("list does not accept positional arguments")
	}
	from, to, err := resolveRange(options, r.now())
	if err != nil {
		return err
	}
	book, err := r.activityLogbook(ctx)
	if err != nil {
		return err
	}
	entries, err := book.List(ctx, from, to, options.project)
	if err != nil {
		return fmt.Errorf("list activities: %w", err)
	}
	output := listOutput{Entries: entries}
	for _, entry := range entries {
		output.TotalMinutes += entry.Minutes
	}
	if options.jsonOutput {
		return writeJSON(r.stdout, output)
	}
	return r.writeEntryList(output)
}

func resolveRange(options listOptions, now time.Time) (time.Time, time.Time, error) {
	if options.date != "" && (options.from != "" || options.to != "") {
		return time.Time{}, time.Time{}, errors.New("date cannot be combined with from or to")
	}
	if options.date != "" {
		start, err := time.ParseInLocation(time.DateOnly, options.date, now.Location())
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("date must use YYYY-MM-DD")
		}
		return start, start.AddDate(0, 0, 1), nil
	}
	if (options.from == "") != (options.to == "") {
		return time.Time{}, time.Time{}, errors.New("from and to must be used together")
	}
	if options.from != "" {
		return logbook.ParseRange(options.from, options.to)
	}
	local := now.In(now.Location())
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	return start, start.AddDate(0, 0, 1), nil
}

func (r *runner) writeEntryList(output listOutput) error {
	if len(output.Entries) == 0 {
		fmt.Fprintln(r.stdout, "No activities in this range.")
		return nil
	}
	w := tabwriter.NewWriter(r.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "START\tEND\tTIME\tPROJECT\tDESCRIPTION")
	for _, entry := range output.Entries {
		end := entry.End
		if entry.Running {
			end = "running"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			entry.Start, end, formatMinutes(entry.Minutes), entry.Project, entry.Description)
	}
	fmt.Fprintf(w, "\t\t%s\tTOTAL\t\n", formatMinutes(output.TotalMinutes))
	return w.Flush()
}

const editHelp = `Edit an activity identified by its current start time.

Use the exact START value printed by "tokify list". Only supplied fields change;
passing an empty --note clears the notes.

Usage:
  tokify edit [OPTIONS] START

Options:
  -p, --project NAME       New project
  -d, --description TEXT  New description
      --new-start TIME     Move the start
  -e, --end TIME           New end
      --note TEXT          Replace notes (empty clears them)
      --json               Print the updated entry as JSON
`

func (r *runner) runEdit(ctx context.Context, args []string) error {
	flags := newFlagSet("edit", editHelp, r.stderr)
	var project, description, newStart, end, notes string
	var jsonOutput bool
	stringFlag(flags, &project, "project", "p", "New project")
	stringFlag(flags, &description, "description", "d", "New description")
	flags.StringVar(&newStart, "new-start", "", "New start time")
	stringFlag(flags, &end, "end", "e", "New end time")
	flags.StringVar(&notes, "note", "", "Replacement notes")
	flags.BoolVar(&jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("edit requires one start time")
	}
	changed := changedFlags(flags)
	request := logbook.UpdateRequest{}
	if changed["project"] || changed["p"] {
		request.Project = &project
	}
	if changed["description"] || changed["d"] {
		request.Description = &description
	}
	if changed["note"] {
		request.Notes = &notes
	}
	if changed["new-start"] {
		parsed, err := parseDateTime(newStart, r.now())
		if err != nil {
			return fmt.Errorf("parse new start time: %w", err)
		}
		request.Start = &parsed
	}
	if changed["end"] || changed["e"] {
		parsed, err := parseDateTime(end, r.now())
		if err != nil {
			return fmt.Errorf("parse end time: %w", err)
		}
		request.End = &parsed
	}
	if request == (logbook.UpdateRequest{}) {
		return errors.New("at least one field to change is required")
	}
	start, err := logbook.ParseTime(flags.Arg(0))
	if err != nil {
		return err
	}
	book, err := r.activityLogbook(ctx)
	if err != nil {
		return err
	}
	entry, err := book.Update(ctx, start, request)
	if err != nil {
		return fmt.Errorf("edit activity: %w", err)
	}
	return r.writeEntry(entry, jsonOutput, "Updated")
}

const removeHelp = `Delete an activity identified by its start time.

Deletion is refused unless --yes is present. Use the exact START value printed
by "tokify list".

Usage:
  tokify remove --yes [--json] START

Options:
  -y, --yes  Confirm deletion
      --json Print the deleted entry as JSON
`

func (r *runner) runRemove(ctx context.Context, args []string) error {
	flags := newFlagSet("remove", removeHelp, r.stderr)
	var confirmed, jsonOutput bool
	boolFlag(flags, &confirmed, "yes", "y", false, "Confirm deletion")
	flags.BoolVar(&jsonOutput, "json", false, "Print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("remove requires one start time")
	}
	if !confirmed {
		return errors.New("refusing to delete without --yes")
	}
	start, err := logbook.ParseTime(flags.Arg(0))
	if err != nil {
		return err
	}
	book, err := r.activityLogbook(ctx)
	if err != nil {
		return err
	}
	entry, err := book.Delete(ctx, start)
	if err != nil {
		return fmt.Errorf("remove activity: %w", err)
	}
	return r.writeEntry(entry, jsonOutput, "Removed")
}

func (r *runner) writeEntry(entry logbook.Entry, jsonOutput bool, verb string) error {
	if jsonOutput {
		return writeJSON(r.stdout, entry)
	}
	fmt.Fprintf(r.stdout, "%s %s · %s (%s to %s)\n",
		verb, entry.Project, entry.Description, entry.Start, entry.End)
	return nil
}

func changedFlags(flags *flag.FlagSet) map[string]bool {
	changed := make(map[string]bool)
	flags.Visit(func(value *flag.Flag) { changed[value.Name] = true })
	return changed
}

func formatMinutes(minutes int) string {
	if minutes < 0 {
		minutes = 0
	}
	return fmt.Sprintf("%02d:%02d", minutes/60, minutes%60)
}
