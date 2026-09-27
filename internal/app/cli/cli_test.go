package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/doug-martin/goqu/v9/dialect/sqlite3"
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStartCurrentAndWatchShareDesktopDatabase(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tokify.db")
	now := time.Date(2026, time.September, 25, 10, 0, 0, 0, time.Local)

	code, stdout, stderr := runCLI(t, now,
		"--database", database,
		"start", "--time", "09:00", "Tokify", "Build CLI",
	)
	require.Equal(t, 0, code, stderr)
	assert.Equal(t, "Started Tokify · Build CLI at 09:00\n", stdout)

	code, stdout, stderr = runCLI(t, now, "--database", database, "watch")
	require.Equal(t, 0, code, stderr)
	assert.Equal(t, "01:00:00\n", stdout)

	code, stdout, stderr = runCLI(t, now,
		"--database", database,
		"current", "--format", "{{.Project}}|{{.Description}}|{{.ElapsedSeconds}}",
	)
	require.Equal(t, 0, code, stderr)
	assert.Equal(t, "Tokify|Build CLI|3600\n", stdout)
}

func TestWatchIdleOutputSupportsPollingAndJSON(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tokify.db")
	now := time.Date(2026, time.September, 25, 10, 0, 0, 0, time.Local)

	code, stdout, stderr := runCLI(t, now, "--database", database, "watch")
	require.Equal(t, 0, code, stderr)
	assert.Empty(t, stdout)

	code, stdout, stderr = runCLI(t, now, "--database", database, "watch", "--idle", "idle")
	require.Equal(t, 0, code, stderr)
	assert.Equal(t, "idle\n", stdout)

	code, stdout, stderr = runCLI(t, now, "--database", database, "watch", "--json")
	require.Equal(t, 0, code, stderr)
	assert.JSONEq(t, `{"running": false, "duration": "00:00:00", "elapsed_seconds": 0}`, stdout)
}

func TestWatchFollowStreamsUntilContextIsCancelled(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tokify.db")
	base := time.Date(2026, time.September, 25, 10, 0, 0, 0, time.Local)
	code, _, stderr := runCLI(t, base,
		"--database", database,
		"start", "--time", "09:00", "Tokify", "Build CLI",
	)
	require.Equal(t, 0, code, stderr)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	output := &cancelWriter{cancel: cancel, after: 3}
	code = Run(ctx, []string{
		"--database", database,
		"watch", "--follow", "--interval", "1ms",
	}, Options{Stdout: output, Stderr: &bytes.Buffer{}, Now: func() time.Time { return base }})
	require.Equal(t, 0, code)
	assert.Equal(t, "01:00:00\n01:00:00\n01:00:00\n", output.String())
}

func TestStartRequiresMetadata(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tokify.db")
	code, _, stderr := runCLI(t, time.Now(), "--database", database, "start", "Project only")
	assert.Equal(t, 1, code)
	assert.Contains(t, stderr, "project and description are required")
}

func TestLogbookAddListEditAndRemove(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tokify.db")
	now := time.Date(2026, time.September, 25, 10, 0, 0, 0, time.Local)
	start := time.Date(2026, time.September, 25, 8, 0, 0, 0, time.Local)

	code, stdout, stderr := runCLI(t, now,
		"--database", database,
		"add", "--start", "08:00", "--duration", "1h30m", "--note", "first draft",
		"Tokify", "Write documentation",
	)
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, "Added Tokify · Write documentation")

	code, stdout, stderr = runCLI(t, now,
		"--database", database,
		"list", "--date", "2026-09-25", "--project", "Tokify", "--json",
	)
	require.Equal(t, 0, code, stderr)
	var listed listOutput
	require.NoError(t, json.Unmarshal([]byte(stdout), &listed))
	require.Len(t, listed.Entries, 1)
	assert.Equal(t, 90, listed.TotalMinutes)
	assert.Equal(t, "first draft", listed.Entries[0].Notes)

	identifier := start.Format(time.RFC3339)
	code, stdout, stderr = runCLI(t, now,
		"--database", database,
		"edit", "--description", "Polish documentation", "--note", "ready", identifier,
	)
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, "Updated Tokify · Polish documentation")

	code, _, stderr = runCLI(t, now, "--database", database, "remove", identifier)
	assert.Equal(t, 1, code)
	assert.Contains(t, stderr, "refusing to delete without --yes")

	code, stdout, stderr = runCLI(t, now,
		"--database", database,
		"remove", "--yes", "--json", identifier,
	)
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, `"description": "Polish documentation"`)

	code, stdout, stderr = runCLI(t, now, "--database", database, "list", "--date", "2026-09-25")
	require.Equal(t, 0, code, stderr)
	assert.Equal(t, "No activities in this range.\n", stdout)
}

func TestAddRejectsOverlappingActivity(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tokify.db")
	now := time.Date(2026, time.September, 25, 12, 0, 0, 0, time.Local)

	code, _, stderr := runCLI(t, now,
		"--database", database,
		"add", "--start", "09:00", "--end", "10:00", "Project", "First",
	)
	require.Equal(t, 0, code, stderr)
	code, _, stderr = runCLI(t, now,
		"--database", database,
		"add", "--start", "09:30", "--end", "10:30", "Project", "Overlap",
	)
	assert.Equal(t, 1, code)
	assert.Contains(t, stderr, "overlaps existing entries")

	code, stdout, stderr := runCLI(t, now,
		"--database", database,
		"list", "--date", "2026-09-25", "--json",
	)
	require.Equal(t, 0, code, stderr)
	var listed listOutput
	require.NoError(t, json.Unmarshal([]byte(stdout), &listed))
	assert.Len(t, listed.Entries, 1)
}

func TestHelpAndVersionDoNotOpenDatabase(t *testing.T) {
	code, stdout, stderr := runCLI(t, time.Now(), "help")
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, "watch       Print its elapsed time")
	assert.Empty(t, stderr)

	code, stdout, stderr = runCLI(t, time.Now(), "version")
	require.Equal(t, 0, code, stderr)
	assert.Equal(t, "dev\n", stdout)

	code, stdout, stderr = runCLI(t, time.Now(), "help", "add")
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, "Add a completed activity")
}

func runCLI(t *testing.T, now time.Time, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), args, Options{
		Stdout: &stdout,
		Stderr: &stderr,
		Now:    func() time.Time { return now },
	})
	return code, stdout.String(), stderr.String()
}

type cancelWriter struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	cancel context.CancelFunc
	after  int
	lines  int
}

func (w *cancelWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lines += strings.Count(string(data), "\n")
	if w.lines >= w.after {
		defer w.cancel()
	}
	return w.buffer.Write(data)
}

func (w *cancelWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buffer.String()
}
