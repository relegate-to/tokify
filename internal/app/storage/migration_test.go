package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/doug-martin/goqu/v9/dialect/sqlite3"
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/kriuchkov/tock/internal/adapters/repositories/notes"
	"github.com/kriuchkov/tock/internal/adapters/repositories/sqlite"
	"github.com/kriuchkov/tock/internal/core/models"
)

func TestMigrateLegacyTextLog(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	legacyPath := filepath.Join(dir, ".tock.txt")
	require.NoError(t, os.WriteFile(legacyPath, []byte(
		"2026-09-06 09:00 - 2026-09-06 10:15 | Tokify | Plan storage\n"+
			"2026-09-07 11:30 | Tokify | Build sketchpad\n",
	), 0o600))

	start := time.Date(2026, 9, 6, 9, 0, 0, 0, time.Local)
	legacyNotes := notes.NewRepository(filepath.Join(dir, ".tock", "notes"))
	require.NoError(t, legacyNotes.Save(ctx, "090000", start, "Keep the backup", []string{"migration"}))

	destination, err := sqlite.NewSQLiteActivityRepository(ctx, filepath.Join(dir, "tokify.db"))
	require.NoError(t, err)

	count, err := MigrateLegacyTextLog(ctx, legacyPath, destination)
	require.NoError(t, err)
	assert.Equal(t, 2, count)

	got, err := destination.Find(ctx, models.ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "Keep the backup", got[0].Notes)
	assert.Equal(t, []string{"migration"}, got[0].Tags)
	assert.Nil(t, got[1].EndTime)

	count, err = MigrateLegacyTextLog(ctx, legacyPath, destination)
	require.NoError(t, err)
	assert.Zero(t, count)
}

func TestMigrateLegacyTextLogDoesNotMergeIntoExistingDatabase(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	legacyPath := filepath.Join(dir, ".tock.txt")
	require.NoError(t, os.WriteFile(legacyPath, []byte(
		"2026-09-06 09:00 - 2026-09-06 10:15 | Old | Legacy entry\n",
	), 0o600))

	destination, err := sqlite.NewSQLiteActivityRepository(ctx, filepath.Join(dir, "tokify.db"))
	require.NoError(t, err)
	require.NoError(t, destination.Save(ctx, models.Activity{
		Description: "Existing entry",
		Project:     "Current",
		StartTime:   time.Date(2026, 9, 7, 12, 0, 0, 0, time.Local),
	}))

	count, err := MigrateLegacyTextLog(ctx, legacyPath, destination)
	require.NoError(t, err)
	assert.Zero(t, count)

	got, err := destination.Find(ctx, models.ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Existing entry", got[0].Description)
}
