package file

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/go-faster/errors"

	coreErrors "github.com/kriuchkov/tock/internal/core/errors"
	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/core/ports"
)

type repository struct {
	filePath string
}

func NewRepository(filePath string) ports.ActivityRepository {
	return &repository{filePath: filePath}
}

func (r *repository) Find(_ context.Context, filter models.ActivityFilter) ([]models.Activity, error) {
	f, err := os.Open(r.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []models.Activity{}, nil
		}
		return nil, errors.Wrap(err, "open file")
	}
	defer f.Close()

	var activities []models.Activity
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()

		if strings.TrimSpace(line) == "" {
			continue
		}

		act, parseErr := ParseActivity(line)
		if parseErr != nil {
			continue
		}

		if act == nil {
			continue
		}

		if filter.Project != nil && act.Project != *filter.Project {
			continue
		}
		if filter.Description != nil && act.Description != *filter.Description {
			continue
		}

		if !overlapsDateRange(*act, filter.FromDate, filter.ToDate) {
			continue
		}

		if filter.IsRunning != nil {
			if *filter.IsRunning && act.EndTime != nil {
				continue
			}
			if !*filter.IsRunning && act.EndTime == nil {
				continue
			}
		}

		activities = append(activities, *act)
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return activities, errors.Wrap(scanErr, "scan file")
	}
	return activities, nil
}

func overlapsDateRange(act models.Activity, fromDate, toDate *time.Time) bool {
	actEnd := time.Now()
	if act.EndTime != nil {
		actEnd = *act.EndTime
	}

	if fromDate != nil && !actEnd.After(*fromDate) {
		return false
	}
	if toDate != nil && !act.StartTime.Before(*toDate) {
		return false
	}
	return true
}

func (r *repository) FindLast(_ context.Context) (*models.Activity, error) {
	f, err := os.Open(r.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, coreErrors.ErrActivityNotFound
		}
		return nil, errors.Wrap(err, "open file")
	}
	defer f.Close()

	var lastAct *models.Activity
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		act, parseErr := ParseActivity(line)
		if parseErr != nil {
			continue
		}
		if act != nil {
			// Keep the activity with the latest start time
			if lastAct == nil || act.StartTime.After(lastAct.StartTime) {
				lastAct = act
			}
		}
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return nil, errors.Wrap(scanErr, "scan file")
	}
	if lastAct == nil {
		return nil, coreErrors.ErrActivityNotFound
	}
	return lastAct, nil
}

func (r *repository) Save(_ context.Context, activity models.Activity) error {
	lines, err := r.readLines()
	if err != nil {
		if !os.IsNotExist(err) {
			return errors.Wrap(err, "read lines")
		}
		// File doesn't exist, will be created on write
		lines = []string{}
	}

	// Check if we are updating an existing activity
	updated := false
	// Iterate backwards to find the most recent entry (though StartTime should be unique)
	for i, v := range slices.Backward(lines) {
		if strings.TrimSpace(v) == "" {
			continue
		}
		act, _ := ParseActivity(v)
		// We identify the activity by StartTime.
		// Since file format might have lower precision (minutes), we compare formatted strings or truncated times.
		// Using Unix() comparison for simplicity, assuming minute precision is enough for uniqueness in this context.
		if act != nil && act.StartTime.Unix()/60 == activity.StartTime.Unix()/60 {
			lines[i] = FormatActivity(activity)
			updated = true
			break
		}
	}

	if !updated {
		lines = append(lines, FormatActivity(activity))
	}

	if writeErr := r.writeLines(lines); writeErr != nil {
		return errors.Wrap(writeErr, "write lines")
	}
	return nil
}

func (r *repository) Remove(_ context.Context, activity models.Activity) error {
	lines, err := r.readLines()
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return errors.Wrap(err, "read lines")
	}

	var newLines []string
	removed := false

	// Iterate over lines.
	// We want to avoid consecutive empty lines if removing an item causes it.
	// We implement a simple cleanup: remove consecutive empty lines.

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// If current line is empty, check if previous was also empty in our new list.
		if trimmed == "" {
			if len(newLines) == 0 {
				continue // Skip leading empty lines
			}
			if strings.TrimSpace(newLines[len(newLines)-1]) == "" {
				continue // Skip duplicate empty line
			}
			newLines = append(newLines, line)
			continue
		}

		act, parseErr := ParseActivity(line)
		if parseErr != nil {
			newLines = append(newLines, line)
			continue
		}

		if act.StartTime.Equal(activity.StartTime) {
			removed = true
			continue
		}
		newLines = append(newLines, line)
	}

	// Remove trailing empty line if it exists to avoid double newlines at EOF
	if len(newLines) > 0 {
		if strings.TrimSpace(newLines[len(newLines)-1]) == "" {
			newLines = newLines[:len(newLines)-1]
		}
	}

	if !removed {
		return errors.New("activity not found")
	}

	if err = r.writeLines(newLines); err != nil {
		return errors.Wrap(err, "write lines")
	}
	return nil
}

// RenameProject rewrites every entry whose project equals oldName so it reads
// newName, leaving each row's timestamp and description byte-for-byte intact. It
// is a whole-file field substitution rather than a per-entry Save loop on
// purpose: Save re-keys a row by its minute-truncated start, so re-saving each
// renamed entry would land it on whatever line shares that clock-minute —
// clobbering a different project's row. Substituting only the project field can
// never mis-target. Returns the number of rows changed.
func (r *repository) RenameProject(_ context.Context, oldName, newName string) (int, error) {
	lines, err := r.readLines()
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, errors.Wrap(err, "read lines")
	}

	changed := 0
	for i, v := range lines {
		parts := strings.Split(v, "|")
		if len(parts) < 3 {
			continue // not an activity line
		}
		if strings.TrimSpace(parts[1]) != oldName {
			continue
		}
		parts[1] = " " + newName + " "
		lines[i] = strings.Join(parts, "|")
		changed++
	}

	if changed == 0 {
		return 0, nil
	}
	if err = r.writeLines(lines); err != nil {
		return 0, errors.Wrap(err, "write lines")
	}
	return changed, nil
}

// DeleteProject removes every entry whose project equals name, dropping the whole
// line so the rows are gone from the log. It is the actual delete behind the
// Projects UI's destructive action, distinct from RenameProject which only
// rewrites the project field. Empty lines are collapsed the same way Remove does
// so a delete leaves no ragged gaps. Returns the number of rows removed.
func (r *repository) DeleteProject(_ context.Context, name string) (int, error) {
	lines, err := r.readLines()
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, errors.Wrap(err, "read lines")
	}

	removed := 0
	newLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			if len(newLines) == 0 || strings.TrimSpace(newLines[len(newLines)-1]) == "" {
				continue
			}
			newLines = append(newLines, line)
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) >= 3 && strings.TrimSpace(parts[1]) == name {
			removed++
			continue
		}
		newLines = append(newLines, line)
	}
	if len(newLines) > 0 && strings.TrimSpace(newLines[len(newLines)-1]) == "" {
		newLines = newLines[:len(newLines)-1]
	}

	if removed == 0 {
		return 0, nil
	}
	if err = r.writeLines(newLines); err != nil {
		return 0, errors.Wrap(err, "write lines")
	}
	return removed, nil
}

func (r *repository) readLines() ([]string, error) {
	f, err := os.Open(r.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, err
		}
		return nil, errors.Wrap(err, "open file")
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return nil, errors.Wrap(scanErr, "scan file")
	}
	return lines, nil
}

func (r *repository) writeLines(lines []string) error {
	// Ensure directory exists
	dir := filepath.Dir(r.filePath)
	if dirErr := os.MkdirAll(dir, 0750); dirErr != nil {
		return errors.Wrap(dirErr, "create directory")
	}

	f, err := os.Create(r.filePath)
	if err != nil {
		return errors.Wrap(err, "create file")
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, line := range lines {
		fmt.Fprintln(w, line)
	}
	if flushErr := w.Flush(); flushErr != nil {
		return errors.Wrap(flushErr, "flush writer")
	}
	return nil
}
