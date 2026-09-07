package storage

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/adapters/repositories/file"
	"github.com/kriuchkov/tock/internal/adapters/repositories/notes"
	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/services/activity"
)

const legacyTextLogMigration = "legacy-text-log-v1"

type oneTimeImporter interface {
	ImportOnce(ctx context.Context, key string, activities []models.Activity) (int, error)
}

// MigrateLegacyTextLog imports the old tock text log into an empty destination.
// The destination owns the one-time marker and atomicity, so a failed import can
// safely be retried without partially replacing the user's history.
func MigrateLegacyTextLog(ctx context.Context, legacyPath string, destination oneTimeImporter) (int, error) {
	legacyPath = expandTilde(strings.TrimSpace(legacyPath))
	if legacyPath == "" {
		return destination.ImportOnce(ctx, legacyTextLogMigration, nil)
	}
	if _, err := os.Stat(legacyPath); err != nil {
		if os.IsNotExist(err) {
			return destination.ImportOnce(ctx, legacyTextLogMigration, nil)
		}
		return 0, errors.Wrap(err, "inspect legacy activity log")
	}

	notesPath := filepath.Join(filepath.Dir(legacyPath), ".tock", "notes")
	source := activity.NewService(file.NewRepository(legacyPath), notes.NewRepository(notesPath))
	activities, err := source.List(ctx, models.ActivityFilter{})
	if err != nil {
		return 0, errors.Wrap(err, "read legacy activity log")
	}
	return destination.ImportOnce(ctx, legacyTextLogMigration, activities)
}

func expandTilde(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}
