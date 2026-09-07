package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/adapters/repositories/sqlite"
	"github.com/kriuchkov/tock/internal/core/ports"
	"github.com/kriuchkov/tock/internal/services/activity"
	"github.com/kriuchkov/tock/internal/timeutil"
)

type Runtime struct {
	ActivityService ports.ActivityResolver
	ActivityRepo    ports.ActivityRepository
	NotesRepository ports.NotesRepository
	DataPath        string
	TimeFormatter   *timeutil.Formatter
}

func Load(ctx context.Context, path string) (*Runtime, error) {
	filePath, err := resolveDatabasePath(path)
	if err != nil {
		return nil, err
	}

	repo, err := sqlite.NewSQLiteActivityRepository(ctx, filePath)
	if err != nil {
		return nil, errors.Wrap(err, "init sqlite repo")
	}
	notesRepo := sqlite.NewNotesRepository(repo.DB)

	return &Runtime{
		ActivityService: activity.NewService(repo, notesRepo),
		ActivityRepo:    repo,
		NotesRepository: notesRepo,
		DataPath:        filePath,
		TimeFormatter:   timeutil.NewFormatter("24"),
	}, nil
}

func (rt *Runtime) DefaultExportDir() (string, error) {
	if strings.TrimSpace(rt.DataPath) == "" {
		return "", errors.New("activity database path is empty")
	}
	return filepath.Dir(rt.DataPath), nil
}

func resolveDatabasePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path != "" {
		return expandTilde(path), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Wrap(err, "home dir")
	}
	return filepath.Join(home, ".tock.db"), nil
}

func expandTilde(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return path
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}
