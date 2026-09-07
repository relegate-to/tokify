package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/doug-martin/goqu/v9"
	"github.com/go-faster/errors"

	coreErrors "github.com/kriuchkov/tock/internal/core/errors"
	"github.com/kriuchkov/tock/internal/core/models"
)

type ActivityRepository struct {
	DB *sql.DB
}

const saveActivitySQL = `
	INSERT INTO activities (description, project, start_time, end_time, notes, tags)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(start_time) DO UPDATE SET
		description=excluded.description,
		project=excluded.project,
		end_time=excluded.end_time,
		notes=excluded.notes,
		tags=excluded.tags;
`

func NewSQLiteActivityRepository(ctx context.Context, dataSourceName string) (*ActivityRepository, error) {
	db, err := sql.Open("sqlite3", dataSourceName)
	if err != nil {
		return nil, errors.Wrap(err, "open database")
	}

	if pingErr := db.PingContext(ctx); pingErr != nil {
		return nil, errors.Wrap(pingErr, "ping database")
	}

	repo := &ActivityRepository{DB: db}
	if initErr := repo.initSchema(ctx); initErr != nil {
		return nil, errors.Wrap(initErr, "initialize schema")
	}

	return repo, nil
}

func (r *ActivityRepository) initSchema(ctx context.Context) error {
	query := `
	CREATE TABLE IF NOT EXISTS activities (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		description TEXT NOT NULL,
		project TEXT NOT NULL,
		start_time DATETIME NOT NULL UNIQUE,
		end_time DATETIME,
		notes TEXT,
		tags TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_start_time ON activities(start_time);
		CREATE TABLE IF NOT EXISTS app_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		`
	_, err := r.DB.ExecContext(ctx, query)
	return err
}

func (r *ActivityRepository) Save(ctx context.Context, activity models.Activity) error {
	return saveActivity(ctx, r.DB, activity)
}

type sqlExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func saveActivity(ctx context.Context, execer sqlExecer, activity models.Activity) error {
	tagsJSON, err := json.Marshal(activity.Tags)
	if err != nil {
		return errors.Wrap(err, "serialize tags")
	}

	var endTime any
	if activity.EndTime != nil {
		endTime = activity.EndTime.UTC()
	}
	_, err = execer.ExecContext(ctx, saveActivitySQL,
		activity.Description,
		activity.Project,
		activity.StartTime.UTC(),
		endTime,
		activity.Notes,
		string(tagsJSON),
	)
	if err != nil {
		return errors.Wrap(err, "save activity")
	}
	return nil
}

// ImportOnce initializes an empty database from a set of activities and records
// the migration key in the same transaction. A database that already contains
// activity is treated as authoritative and only gets the marker.
func (r *ActivityRepository) ImportOnce(ctx context.Context, key string, activities []models.Activity) (int, error) {
	tx, err := r.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, errors.Wrap(err, "begin import")
	}
	defer tx.Rollback() //nolint:errcheck // commit is the success path

	var marker string
	err = tx.QueryRowContext(ctx, `SELECT value FROM app_metadata WHERE key = ?`, key).Scan(&marker)
	if err == nil {
		return 0, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, errors.Wrap(err, "read import marker")
	}

	var existing int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM activities`).Scan(&existing); err != nil {
		return 0, errors.Wrap(err, "count activities")
	}

	imported := 0
	if existing == 0 {
		for _, activity := range activities {
			if err = saveActivity(ctx, tx, activity); err != nil {
				return 0, errors.Wrap(err, "import activity")
			}
			imported++
		}
	}

	if _, err = tx.ExecContext(ctx, `INSERT INTO app_metadata (key, value) VALUES (?, 'complete')`, key); err != nil {
		return 0, errors.Wrap(err, "write import marker")
	}
	if err = tx.Commit(); err != nil {
		return 0, errors.Wrap(err, "commit import")
	}
	return imported, nil
}

func (r *ActivityRepository) FindLast(ctx context.Context) (*models.Activity, error) {
	query := `
	SELECT description, project, start_time, end_time, notes, tags
	FROM activities
	ORDER BY start_time DESC
	LIMIT 1
	`
	row := r.DB.QueryRowContext(ctx, query)
	return scanActivity(row)
}

func (r *ActivityRepository) Find(ctx context.Context, filter models.ActivityFilter) ([]models.Activity, error) {
	dialect := goqu.Dialect("sqlite3")
	dataset := dialect.From("activities").
		Select("description", "project", "start_time", "end_time", "notes", "tags").
		Order(goqu.I("start_time").Asc())

	if filter.FromDate != nil {
		dataset = dataset.Where(goqu.Or(
			goqu.I("end_time").IsNull(),
			goqu.I("end_time").Gt(filter.FromDate.UTC()),
		))
	}
	if filter.ToDate != nil {
		dataset = dataset.Where(goqu.I("start_time").Lt(filter.ToDate.UTC()))
	}
	if filter.Project != nil && *filter.Project != "" {
		dataset = dataset.Where(goqu.Ex{"project": *filter.Project})
	}
	if filter.Description != nil && *filter.Description != "" {
		dataset = dataset.Where(goqu.I("description").Like("%" + *filter.Description + "%"))
	}
	if filter.IsRunning != nil {
		if *filter.IsRunning {
			dataset = dataset.Where(goqu.I("end_time").IsNull())
		} else {
			dataset = dataset.Where(goqu.I("end_time").IsNotNull())
		}
	}

	query, args, err := dataset.Prepared(true).ToSQL()
	if err != nil {
		return nil, errors.Wrap(err, "build query")
	}

	rows, err := r.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, errors.Wrap(err, "find activities")
	}
	defer rows.Close()

	var activities []models.Activity
	for rows.Next() {
		activity, scanErr := scanActivity(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		if activity != nil {
			activities = append(activities, *activity)
		}
	}

	if iterErr := rows.Err(); iterErr != nil {
		return nil, errors.Wrap(iterErr, "error iterating over activities")
	}

	return activities, nil
}

func (r *ActivityRepository) Remove(ctx context.Context, activity models.Activity) error {
	query := `DELETE FROM activities WHERE start_time = ?`
	_, err := r.DB.ExecContext(ctx, query, activity.StartTime.UTC())
	if err != nil {
		return errors.Wrap(err, "remove activity")
	}
	return nil
}

func (r *ActivityRepository) RenameProject(ctx context.Context, oldName, newName string) (int, error) {
	result, err := r.DB.ExecContext(ctx, `UPDATE activities SET project = ? WHERE project = ?`, newName, oldName)
	if err != nil {
		return 0, errors.Wrap(err, "rename project")
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return 0, errors.Wrap(err, "count renamed activities")
	}
	return int(changed), nil
}

func (r *ActivityRepository) DeleteProject(ctx context.Context, name string) (int, error) {
	result, err := r.DB.ExecContext(ctx, `DELETE FROM activities WHERE project = ?`, name)
	if err != nil {
		return 0, errors.Wrap(err, "delete project")
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return 0, errors.Wrap(err, "count deleted activities")
	}
	return int(removed), nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanActivity(s scanner) (*models.Activity, error) {
	var act models.Activity
	var endTime sql.NullTime
	var tagsString sql.NullString
	var notesString sql.NullString

	err := s.Scan(
		&act.Description,
		&act.Project,
		&act.StartTime,
		&endTime,
		&notesString,
		&tagsString,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, coreErrors.ErrActivityNotFound
		}
		return nil, errors.Wrap(err, "scan activity")
	}

	act.StartTime = act.StartTime.Local()

	if endTime.Valid {
		localEndTime := endTime.Time.Local()
		act.EndTime = &localEndTime
	}

	if notesString.Valid {
		act.Notes = notesString.String
	}

	if tagsString.Valid && tagsString.String != "" {
		if unmarshalErr := json.Unmarshal([]byte(tagsString.String), &act.Tags); unmarshalErr != nil {
			return nil, errors.Wrap(unmarshalErr, "failed to unmarshal tags")
		}
	}

	return &act, nil
}
