package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/doug-martin/goqu/v9/dialect/sqlite3" // register the goqu sqlite3 dialect
	_ "github.com/mattn/go-sqlite3"                    // register the sqlite3 database driver

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	coreErrors "github.com/kriuchkov/tock/internal/core/errors"
	"github.com/kriuchkov/tock/internal/core/models"
)

func setupTestDB(t *testing.T) *ActivityRepository {
	t.Helper()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test_tock.db")

	repo, err := NewSQLiteActivityRepository(t.Context(), dbPath)
	require.NoError(t, err)
	return repo
}

func TestSQLiteRepository_Save(t *testing.T) {
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)

	tests := []struct {
		name     string
		activity models.Activity
		setup    func(repo *ActivityRepository)
		verify   func(t *testing.T, repo *ActivityRepository)
	}{
		{
			name: "insert new running activity",
			activity: models.Activity{
				Description: "Fix bugs",
				Project:     "Tock",
				StartTime:   now,
				Tags:        []string{"bug", "golang"},
				Notes:       "Found a few issues in the repo",
			},
			verify: func(t *testing.T, repo *ActivityRepository) {
				last, err := repo.FindLast(ctx)
				require.NoError(t, err)
				require.NotNil(t, last)
				assert.Equal(t, "Fix bugs", last.Description)
				assert.Equal(t, "Tock", last.Project)
				assert.True(t, now.Equal(last.StartTime))
				assert.Nil(t, last.EndTime)
				assert.Equal(t, []string{"bug", "golang"}, last.Tags)
				assert.Equal(t, "Found a few issues in the repo", last.Notes)
			},
		},
		{
			name: "update existing activity",
			activity: models.Activity{
				Description: "Fix bugs (updated)",
				Project:     "Tock",
				StartTime:   now, // Same start time will trigger ON CONFLICT update
				EndTime:     new(now.Add(time.Hour)),
				Tags:        []string{"updated"},
				Notes:       "Updated notes",
			},
			setup: func(repo *ActivityRepository) {
				// Insert the initial record
				_ = repo.Save(ctx, models.Activity{
					Description: "Fix bugs",
					Project:     "Tock",
					StartTime:   now,
					Tags:        []string{"bug"},
				})
			},
			verify: func(t *testing.T, repo *ActivityRepository) {
				last, err := repo.FindLast(ctx)
				require.NoError(t, err)
				require.NotNil(t, last)
				assert.Equal(t, "Fix bugs (updated)", last.Description)
				assert.Equal(t, []string{"updated"}, last.Tags)
				require.NotNil(t, last.EndTime)
				assert.True(t, now.Add(time.Hour).Equal(*last.EndTime))
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := setupTestDB(t)

			if tt.setup != nil {
				tt.setup(repo)
			}

			err := repo.Save(ctx, tt.activity)
			require.NoError(t, err)

			if tt.verify != nil {
				tt.verify(t, repo)
			}
		})
	}
}

func TestSQLiteRepository_FindLast(t *testing.T) {
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)

	tests := []struct {
		name         string
		setup        func(repo *ActivityRepository)
		expectNil    bool
		expectedDesc string
	}{
		{
			name:      "empty database",
			setup:     func(_ *ActivityRepository) {},
			expectNil: true,
		},
		{
			name: "multiple activities, returns the most recent one",
			setup: func(repo *ActivityRepository) {
				_ = repo.Save(ctx, models.Activity{Description: "Past", Project: "A", StartTime: now.Add(-2 * time.Hour)})
				_ = repo.Save(ctx, models.Activity{Description: "Present", Project: "B", StartTime: now})
				_ = repo.Save(ctx, models.Activity{Description: "Older", Project: "A", StartTime: now.Add(-4 * time.Hour)})
			},
			expectNil:    false,
			expectedDesc: "Present",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := setupTestDB(t)
			tt.setup(repo)

			last, err := repo.FindLast(ctx)

			if tt.expectNil {
				require.ErrorIs(t, err, coreErrors.ErrActivityNotFound)
				assert.Nil(t, last)
			} else {
				require.NoError(t, err)
				require.NotNil(t, last)
				assert.Equal(t, tt.expectedDesc, last.Description)
			}
		})
	}
}

func TestSQLiteRepository_Find(t *testing.T) {
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)

	// We create a standard set of records for filtering out
	standardSetup := func(repo *ActivityRepository) {
		// Act 1: Tock project, ran 2 hours ago for 1 hour
		_ = repo.Save(ctx, models.Activity{
			Description: "Design architecture",
			Project:     "Tock",
			StartTime:   now.Add(-2 * time.Hour),
			EndTime:     new(now.Add(-1 * time.Hour)),
			Tags:        []string{"design"},
		})

		// Act 2: Tock project, running now
		_ = repo.Save(ctx, models.Activity{
			Description: "Implement DB",
			Project:     "Tock",
			StartTime:   now,
			Tags:        []string{"db"},
		})

		// Act 3: SideProject, ran yesterday
		_ = repo.Save(ctx, models.Activity{
			Description: "Initial commit",
			Project:     "SideProject",
			StartTime:   now.Add(-24 * time.Hour),
			EndTime:     new(now.Add(-23 * time.Hour)),
		})
	}

	tests := []struct {
		name          string
		filter        models.ActivityFilter
		expectedCount int
		verify        func(t *testing.T, acts []models.Activity)
	}{
		{
			name:          "no filter, returns all",
			filter:        models.ActivityFilter{},
			expectedCount: 3,
		},
		{
			name: "filter by project Tock",
			filter: models.ActivityFilter{
				Project: new("Tock"),
			},
			expectedCount: 2,
			verify: func(t *testing.T, acts []models.Activity) {
				for _, a := range acts {
					assert.Equal(t, "Tock", a.Project)
				}
			},
		},
		{
			name: "filter by partial description (Like clause)",
			filter: models.ActivityFilter{
				Description: new("DB"),
			},
			expectedCount: 1,
			verify: func(t *testing.T, acts []models.Activity) {
				assert.Equal(t, "Implement DB", acts[0].Description)
			},
		},
		{
			name: "filter by IsRunning (true)",
			filter: models.ActivityFilter{
				IsRunning: new(true),
			},
			expectedCount: 1,
			verify: func(t *testing.T, acts []models.Activity) {
				assert.Nil(t, acts[0].EndTime)
				assert.Equal(t, "Implement DB", acts[0].Description)
			},
		},
		{
			name: "filter by IsRunning (false)",
			filter: models.ActivityFilter{
				IsRunning: new(false),
			},
			expectedCount: 2,
			verify: func(t *testing.T, acts []models.Activity) {
				for _, a := range acts {
					assert.NotNil(t, a.EndTime)
				}
			},
		},
		{
			name: "filter by FromDate",
			filter: models.ActivityFilter{
				FromDate: new(now.Add(-3 * time.Hour)),
			},
			expectedCount: 2, // skips the one from 24h ago
		},
		{
			name: "filter by ToDate",
			filter: models.ActivityFilter{
				ToDate: new(now.Add(-10 * time.Hour)),
			},
			expectedCount: 1, // only the one from 24h ago
			verify: func(t *testing.T, acts []models.Activity) {
				assert.Equal(t, "SideProject", acts[0].Project)
			},
		},
		{
			name: "filter by combination (Project + IsRunning)",
			filter: models.ActivityFilter{
				Project:   new("Tock"),
				IsRunning: new(false),
			},
			expectedCount: 1,
			verify: func(t *testing.T, acts []models.Activity) {
				assert.Equal(t, "Design architecture", acts[0].Description)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := setupTestDB(t)
			standardSetup(repo)

			acts, err := repo.Find(ctx, tt.filter)
			require.NoError(t, err)

			assert.Len(t, acts, tt.expectedCount)
			if tt.verify != nil && len(acts) > 0 {
				tt.verify(t, acts)
			}
		})
	}
}

func TestSQLiteRepository_Remove(t *testing.T) {
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)

	tests := []struct {
		name       string
		setup      func(repo *ActivityRepository)
		toRemove   models.Activity
		finalCount int
	}{
		{
			name: "remove existing activity",
			setup: func(repo *ActivityRepository) {
				_ = repo.Save(ctx, models.Activity{Description: "A", Project: "1", StartTime: now})
				_ = repo.Save(ctx, models.Activity{Description: "B", Project: "2", StartTime: now.Add(-time.Hour)})
			},
			toRemove:   models.Activity{StartTime: now}, // Start time is the unique key
			finalCount: 1,
		},
		{
			name: "remove non-existing activity (no-op)",
			setup: func(repo *ActivityRepository) {
				_ = repo.Save(ctx, models.Activity{Description: "A", Project: "1", StartTime: now})
			},
			toRemove:   models.Activity{StartTime: now.Add(-time.Hour)},
			finalCount: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := setupTestDB(t)
			tt.setup(repo)

			err := repo.Remove(ctx, tt.toRemove)
			require.NoError(t, err)

			acts, err := repo.Find(ctx, models.ActivityFilter{})
			require.NoError(t, err)
			assert.Len(t, acts, tt.finalCount)
		})
	}
}

func TestSQLiteRepository_FindIncludesActivityOverlappingRange(t *testing.T) {
	ctx := context.Background()
	repo := setupTestDB(t)
	start := time.Date(2026, 9, 6, 23, 30, 0, 0, time.Local)
	end := time.Date(2026, 9, 7, 0, 30, 0, 0, time.Local)
	require.NoError(t, repo.Save(ctx, models.Activity{
		Description: "Across midnight",
		Project:     "Night shift",
		StartTime:   start,
		EndTime:     &end,
	}))

	from := time.Date(2026, 9, 7, 0, 0, 0, 0, time.Local)
	to := from.AddDate(0, 0, 1)
	got, err := repo.Find(ctx, models.ActivityFilter{FromDate: &from, ToDate: &to})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Across midnight", got[0].Description)
}

func TestSQLiteRepository_ProjectMutations(t *testing.T) {
	ctx := context.Background()
	repo := setupTestDB(t)
	now := time.Now().Truncate(time.Second)
	for i, project := range []string{"Old", "Keep", "Old"} {
		require.NoError(t, repo.Save(ctx, models.Activity{
			Description: "Activity",
			Project:     project,
			StartTime:   now.Add(time.Duration(i) * time.Minute),
		}))
	}

	renamed, err := repo.RenameProject(ctx, "Old", "New")
	require.NoError(t, err)
	assert.Equal(t, 2, renamed)

	removed, err := repo.DeleteProject(ctx, "New")
	require.NoError(t, err)
	assert.Equal(t, 2, removed)

	got, err := repo.Find(ctx, models.ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Keep", got[0].Project)
}
