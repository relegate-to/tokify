// Package mcpserver exposes the Tokify activity log to AI agents over MCP
// (stdio). The desktop binary serves it when launched with the mcp argument, so
// agents read and change ~/.tock.db under the same rules as the app, which
// picks up changes on its next refresh and syncs them like any local edit.
package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/go-faster/errors"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kriuchkov/tock/internal/app/logbook"
	"github.com/kriuchkov/tock/internal/app/projects"
	"github.com/kriuchkov/tock/internal/app/runtime"
	"github.com/kriuchkov/tock/internal/appdir"
	"github.com/kriuchkov/tock/internal/integrations/neonsync"
)

const instructions = `Tokify is the user's time tracker. Use these tools to review and correct their hours.
Call list_activities for the range first to see what exists and find gaps, and list_projects so
entries reuse existing project names exactly. Entries cannot overlap; changes that would overlap
are refused with the conflicting entries listed. Times without an offset are the user's local time.
update_activity and delete_activity identify an entry by its start exactly as list_activities
returned it. Confirm with the user before deleting or making large changes.`

type listActivitiesInput struct {
	From    string `json:"from"              jsonschema:"start of range: YYYY-MM-DD (start of that local day) or a time"`
	To      string `json:"to"                jsonschema:"end of range: YYYY-MM-DD (inclusive, end of that local day) or a time (exclusive)"`
	Project string `json:"project,omitempty" jsonschema:"only entries for this exact project name"`
}

type listActivitiesOutput struct {
	Entries      []logbook.Entry `json:"entries"`
	TotalMinutes int             `json:"total_minutes"`
}

type addActivityInput struct {
	Description string `json:"description"     jsonschema:"what was worked on"`
	Project     string `json:"project"         jsonschema:"project name; reuse a name from list_projects"`
	Start       string `json:"start"           jsonschema:"start time: YYYY-MM-DD HH:MM in local time, or RFC 3339"`
	End         string `json:"end"             jsonschema:"end time: YYYY-MM-DD HH:MM in local time, or RFC 3339"`
	Notes       string `json:"notes,omitempty" jsonschema:"optional free-form notes"`
}

type updateActivityInput struct {
	Start       string  `json:"start"                 jsonschema:"start of the entry to change, as returned by list_activities"`
	Description *string `json:"description,omitempty" jsonschema:"new description"`
	Project     *string `json:"project,omitempty"     jsonschema:"new project name"`
	NewStart    *string `json:"new_start,omitempty"   jsonschema:"new start time: YYYY-MM-DD HH:MM in local time, or RFC 3339"`
	End         *string `json:"end,omitempty"         jsonschema:"new end time; setting it on a running entry stops it"`
	Notes       *string `json:"notes,omitempty"       jsonschema:"new notes; empty string clears them"`
}

type deleteActivityInput struct {
	Start string `json:"start" jsonschema:"start of the entry to delete, as returned by list_activities"`
}

type entryOutput struct {
	Entry logbook.Entry `json:"entry"`
}

type deleteOutput struct {
	Deleted logbook.Entry `json:"deleted" jsonschema:"the entry as it was; add_activity can restore it"`
}

type listProjectsOutput struct {
	Projects []string `json:"projects" jsonschema:"project names, most recently used first"`
}

// Serve runs the server on stdin/stdout until the client disconnects or ctx is
// cancelled, against the same profile database the desktop app opens.
func Serve(ctx context.Context) error {
	rt, err := runtime.Load(ctx, appdir.DatabasePath())
	if err != nil {
		return errors.Wrap(err, "load activity database")
	}
	// Only the local tombstone file is used, so no sign-in token is needed.
	syncService, err := neonsync.NewService(rt.ActivityService, nil)
	if err != nil {
		return errors.Wrap(err, "load sync settings")
	}
	server := newServer(logbook.New(rt.ActivityRepo, syncService, registeredProjects))
	if runErr := server.Run(ctx, &mcp.StdioTransport{}); runErr != nil && ctx.Err() == nil {
		return errors.Wrap(runErr, "mcp server")
	}
	return nil
}

func newServer(book *logbook.Logbook) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "tokify", Version: "0.2.0"}, &mcp.ServerOptions{Instructions: instructions})
	addReadTools(server, book)
	addWriteTools(server, book)
	return server
}

func addReadTools(server *mcp.Server, book *logbook.Logbook) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_activities",
		Description: "List time entries overlapping a date or time range, oldest first.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listActivitiesInput) (*mcp.CallToolResult, listActivitiesOutput, error) {
		from, to, rangeErr := logbook.ParseRange(in.From, in.To)
		if rangeErr != nil {
			return nil, listActivitiesOutput{}, rangeErr
		}
		entries, listErr := book.List(ctx, from, to, in.Project)
		if listErr != nil {
			return nil, listActivitiesOutput{}, listErr
		}
		out := listActivitiesOutput{Entries: entries}
		for _, e := range entries {
			out.TotalMinutes += e.Minutes
		}
		return nil, out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_projects",
		Description: "List known project names, most recently used first.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, listProjectsOutput, error) {
		names, projErr := book.Projects(ctx)
		if projErr != nil {
			return nil, listProjectsOutput{}, projErr
		}
		return nil, listProjectsOutput{Projects: names}, nil
	})
}

func addWriteTools(server *mcp.Server, book *logbook.Logbook) {
	destructive := true
	notDestructive := false

	mcp.AddTool(server, &mcp.Tool{
		Name:        "add_activity",
		Description: "Add a completed time entry. Fails without writing if it overlaps an existing entry or ends in the future.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &notDestructive},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in addActivityInput) (*mcp.CallToolResult, entryOutput, error) {
		start, startErr := logbook.ParseTime(in.Start)
		if startErr != nil {
			return nil, entryOutput{}, startErr
		}
		end, endErr := logbook.ParseTime(in.End)
		if endErr != nil {
			return nil, entryOutput{}, endErr
		}
		added, addErr := book.Add(ctx, logbook.AddRequest{
			Description: in.Description,
			Project:     in.Project,
			Start:       start,
			End:         end,
			Notes:       in.Notes,
		})
		if addErr != nil {
			return nil, entryOutput{}, addErr
		}
		return nil, entryOutput{Entry: added}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "update_activity",
		Description: "Change an entry's description, project, notes, start, or end. Only the fields given change. " +
			"Fails without writing if the result would overlap another entry or end in the future.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &destructive, IdempotentHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateActivityInput) (*mcp.CallToolResult, entryOutput, error) {
		start, parseErr := logbook.ParseTime(in.Start)
		if parseErr != nil {
			return nil, entryOutput{}, parseErr
		}
		req := logbook.UpdateRequest{Description: in.Description, Project: in.Project, Notes: in.Notes}
		if parseErr = parseOptionalTime(in.NewStart, &req.Start); parseErr != nil {
			return nil, entryOutput{}, parseErr
		}
		if parseErr = parseOptionalTime(in.End, &req.End); parseErr != nil {
			return nil, entryOutput{}, parseErr
		}
		updated, updateErr := book.Update(ctx, start, req)
		if updateErr != nil {
			return nil, entryOutput{}, updateErr
		}
		return nil, entryOutput{Entry: updated}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_activity",
		Description: "Delete an entry. Returns it as it was so it can be re-added if the delete was a mistake.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &destructive},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in deleteActivityInput) (*mcp.CallToolResult, deleteOutput, error) {
		start, parseErr := logbook.ParseTime(in.Start)
		if parseErr != nil {
			return nil, deleteOutput{}, parseErr
		}
		deleted, deleteErr := book.Delete(ctx, start)
		if deleteErr != nil {
			return nil, deleteOutput{}, deleteErr
		}
		return nil, deleteOutput{Deleted: deleted}, nil
	})
}

func parseOptionalTime(s *string, dst **time.Time) error {
	if s == nil {
		return nil
	}
	t, err := logbook.ParseTime(*s)
	if err != nil {
		return err
	}
	*dst = &t
	return nil
}

// registeredProjects re-reads the registry on each call so projects created in
// the desktop app while this server runs are still offered.
func registeredProjects() []string {
	path, err := projects.DefaultPath()
	if err != nil {
		return nil
	}
	reg, err := projects.Open(path)
	if err != nil {
		return nil
	}
	var names []string
	for _, p := range reg.List() {
		names = append(names, p.Name)
	}
	return names
}

// Setup is what a user pastes into an agent to register this server: a Claude
// Code command and the equivalent mcpServers JSON most other clients accept.
type Setup struct {
	ClaudeCommand string `json:"claude_command"`
	JSONConfig    string `json:"json_config"`
}

// SetupFor describes launching executable with the mcp argument. The active
// profile is passed through so the agent writes to the database this app shows.
func SetupFor(executable, arg string) (Setup, error) {
	type server struct {
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env,omitempty"`
	}
	srv := server{Command: executable, Args: []string{arg}}

	cmd := []string{"claude", "mcp", "add", "--scope", "user"}
	if p := appdir.Profile(); p != "" {
		srv.Env = map[string]string{"TOKIFY_PROFILE": p}
		cmd = append(cmd, "--env", shellQuote("TOKIFY_PROFILE="+p))
	}
	cmd = append(cmd, "tokify", "--", shellQuote(executable), arg)

	data, err := json.MarshalIndent(map[string]map[string]server{"mcpServers": {"tokify": srv}}, "", "  ")
	if err != nil {
		return Setup{}, errors.Wrap(err, "marshal mcp config")
	}
	return Setup{ClaudeCommand: strings.Join(cmd, " "), JSONConfig: string(data)}, nil
}

func shellQuote(s string) string {
	const safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-=+:@"
	if s != "" && strings.Trim(s, safe) == "" {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
