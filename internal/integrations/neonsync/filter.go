package neonsync

import (
	"encoding/json"
	"slices"
	"time"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/core/models"
)

// shareFilter is the minimal v1 filter (plan §4/§7): a plaintext predicate the
// OWNER's client evaluates locally, never the database. It is serialized,
// encrypted to the audience's current epoch key, and stored as the shares row's
// filter_ciphertext. The DB only ever sees the ciphertext; it decides visibility
// from grant membership, not from this predicate.
//
// v1 supports two dimensions, ANDed together:
//   - Projects: an entry matches only if its project is in this list. An empty
//     list means "any project" (no project constraint).
//   - SinceDays: an entry matches only if it started within the last N days.
//     Zero means "no lower bound".
//
// Fields are a fixed-field struct so json.Marshal is deterministic and the
// re-wrap on epoch bump reproduces identical plaintext.
type shareFilter struct {
	Projects  []string `json:"projects"`
	SinceDays int      `json:"since_days"`
}

func (f shareFilter) marshal() ([]byte, error) {
	b, err := json.Marshal(f)
	if err != nil {
		return nil, errors.Wrap(err, "marshal filter")
	}
	return b, nil
}

func unmarshalFilter(b []byte) (shareFilter, error) {
	var f shareFilter
	if err := json.Unmarshal(b, &f); err != nil {
		return shareFilter{}, errors.Wrap(err, "unmarshal filter")
	}
	return f, nil
}

// matches reports whether an entry falls inside the filter's slice, evaluated
// against now. A completed entry with no project matches only when Projects is
// empty. since is the lower time bound; entries starting before it are excluded.
func (f shareFilter) matches(a models.Activity, now time.Time) bool {
	if len(f.Projects) > 0 && !containsString(f.Projects, a.Project) {
		return false
	}
	if f.SinceDays > 0 {
		lower := now.AddDate(0, 0, -f.SinceDays)
		if a.StartTime.Before(lower) {
			return false
		}
	}
	return true
}

// validUntil precomputes the grant's trailing edge for a time-window slice (plan
// §4 step 3): once an entry ages past the window it should stop being shared
// without anyone online. For a SinceDays window the entry leaves the slice N
// days after it started, so valid_until = start + N days. A zero window has no
// upper bound (nil), matching the nullable grants column.
func (f shareFilter) validUntil(a models.Activity) *time.Time {
	if f.SinceDays <= 0 {
		return nil
	}
	end := a.StartTime.AddDate(0, 0, f.SinceDays)
	return &end
}

func containsString(list []string, v string) bool {
	return slices.Contains(list, v)
}
