//go:build darwin

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/kriuchkov/tock/internal/appdir"
	"github.com/kriuchkov/tock/internal/core/models"
)

// sharedCache is the desktop-side, disk-persisted cache of decrypted shared
// activity. The shared read path (neonsync.ListSharedEntries) is a multi-round
// network walk plus per-entry crypto; running it on every poll — and, worse, on
// a cold start where the frontend begins empty — is the source of the visible
// latency in the Activity, Now, and History views. This cache lets
// SharingSharedEntries return the last-good, fully-resolved rows instantly while
// a refresh runs in the background.
//
// Persisting to the profile dir means a cold start paints immediately from the
// previous session's rows. The file holds other members' decrypted plaintext,
// which is consistent with tock's model: the local activity log (~/.tock.txt) is
// already plaintext on disk, and the profile dir is the same trust boundary.
type sharedCache struct {
	path string

	mu     sync.Mutex
	loaded bool
	raw    []byte
	items  []SharedActivity
}

type sharedCacheFile struct {
	Entries []SharedActivity `json:"entries"`
}

// openSharedCache loads the cache from disk, returning an empty (but usable)
// cache when the file does not exist yet. A malformed file is treated as empty
// rather than fatal — the background refresh will repopulate it.
func openSharedCache(path string) *sharedCache {
	c := &sharedCache{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var f sharedCacheFile
	if json.Unmarshal(data, &f) != nil {
		return c
	}
	c.loaded = true
	c.raw = data
	c.items = f.Entries
	return c
}

// warm reports whether the cache holds a usable snapshot (from disk or a prior
// refresh). A cold cache forces the first read to fetch synchronously.
func (c *sharedCache) warm() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.loaded
}

// get returns a copy of the cached rows.
func (c *sharedCache) get() []SharedActivity {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]SharedActivity, len(c.items))
	copy(out, c.items)
	return out
}

// set replaces the cached rows and persists them, returning true when the
// snapshot actually changed. The change check keeps the hot poll path from
// rewriting the file (and re-emitting the update event) every few seconds.
func (c *sharedCache) set(items []SharedActivity) bool {
	data, err := json.Marshal(sharedCacheFile{Entries: items})
	if err != nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded && bytes.Equal(data, c.raw) {
		return false
	}
	c.loaded = true
	c.raw = data
	c.items = items
	c.persist(data)
	return true
}

// clear empties the cache in memory and removes the on-disk file. Used on sign
// out so another member's decrypted rows don't linger. A cleared cache reports
// cold, so the next signed-in read fetches synchronously.
func (c *sharedCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loaded = false
	c.raw = nil
	c.items = nil
	if c.path != "" {
		_ = os.Remove(c.path)
	}
}

// persist writes the snapshot atomically. Callers hold c.mu. A write failure is
// swallowed: the in-memory cache is still authoritative for this session, and a
// stale/absent file only costs a slower next cold start.
func (c *sharedCache) persist(data []byte) {
	if c.path == "" {
		return
	}
	if os.MkdirAll(filepath.Dir(c.path), 0o700) != nil {
		return
	}
	tmp := c.path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil {
		return
	}
	_ = os.Rename(tmp, c.path)
}

// sharedCachePath is where the shared-activity cache lives, next to the other
// profile-scoped Tokify state files.
func sharedCachePath() (string, error) {
	return appdir.Path("shared-cache.json")
}

// foldSharedIntoReport merges shared activities into a report built from the
// local log, applying the same project filter and range clipping GetReport uses
// for local entries so an "include shared" export stays consistent with a
// local-only one. The merged activity lists are re-sorted by start time so the
// export reads chronologically rather than local-then-shared. It mirrors the
// clip in internal/services/activity; the duplication is deliberate — this is a
// desktop-only export concern and must not push shared-entry logic upstream.
func foldSharedIntoReport(report *models.Report, shared []models.Activity, filter models.ActivityFilter) {
	now := time.Now()
	for _, act := range shared {
		if filter.Project != nil && act.Project != *filter.Project {
			continue
		}
		clipped, ok := clipSharedByRange(act, filter, now)
		if !ok {
			continue
		}
		report.Activities = append(report.Activities, clipped)
		duration := clipped.Duration()
		report.TotalDuration += duration

		pr, exists := report.ByProject[clipped.Project]
		if !exists {
			pr = models.ProjectReport{ProjectName: clipped.Project, Activities: []models.Activity{}}
		}
		pr.Duration += duration
		pr.Activities = append(pr.Activities, clipped)
		report.ByProject[clipped.Project] = pr
	}

	sort.SliceStable(report.Activities, func(i, j int) bool {
		return report.Activities[i].StartTime.Before(report.Activities[j].StartTime)
	})
	for name, pr := range report.ByProject {
		sort.SliceStable(pr.Activities, func(i, j int) bool {
			return pr.Activities[i].StartTime.Before(pr.Activities[j].StartTime)
		})
		report.ByProject[name] = pr
	}
}

func clipSharedByRange(act models.Activity, filter models.ActivityFilter, now time.Time) (models.Activity, bool) {
	start := act.StartTime
	end := now
	if act.EndTime != nil {
		end = *act.EndTime
	}
	if filter.FromDate != nil && start.Before(*filter.FromDate) {
		start = *filter.FromDate
	}
	if filter.ToDate != nil && end.After(*filter.ToDate) {
		end = *filter.ToDate
	}
	if !end.After(start) {
		return models.Activity{}, false
	}
	clipped := act
	clipped.StartTime = start
	clippedEnd := end
	clipped.EndTime = &clippedEnd
	return clipped, true
}
