//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-faster/errors"
)

// version is the running app version. It mirrors productVersion in wails.json and
// can be overridden at build time with -ldflags "-X main.version=1.2.3".
var version = "0.1.0"

const (
	releaseAPIURL = "https://api.github.com/repos/relegate-to/tokify/releases/latest"
	releasesURL   = "https://github.com/relegate-to/tokify/releases"
)

// UpdateInfo reports the result of checking GitHub for a newer release.
type UpdateInfo struct {
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	ReleaseURL      string `json:"release_url"`
	ReleaseNotes    string `json:"release_notes"`
	PublishedAt     string `json:"published_at"`
}

// AppVersion returns the running app version for display in Settings.
func (a *App) AppVersion() string { return version }

// CheckForUpdate queries the tokify GitHub releases API for the latest published
// release and compares it against the running version. A 404 (no releases yet)
// is reported as "up to date" rather than an error.
func (a *App) CheckForUpdate() (UpdateInfo, error) {
	info := UpdateInfo{
		CurrentVersion: version,
		LatestVersion:  version,
		ReleaseURL:     releasesURL,
	}

	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releaseAPIURL, nil)
	if err != nil {
		return info, errors.Wrap(err, "build request")
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return info, errors.Wrap(err, "contact GitHub")
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return info, nil // no releases published yet
	}
	if resp.StatusCode != http.StatusOK {
		return info, errors.Errorf("GitHub returned %s", resp.Status)
	}

	var rel struct {
		TagName     string `json:"tag_name"`
		HTMLURL     string `json:"html_url"`
		Body        string `json:"body"`
		PublishedAt string `json:"published_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info, errors.Wrap(err, "decode release")
	}

	latest := strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v")
	if latest != "" {
		info.LatestVersion = latest
	}
	if rel.HTMLURL != "" {
		info.ReleaseURL = rel.HTMLURL
	}
	info.ReleaseNotes = strings.TrimSpace(rel.Body)
	info.PublishedAt = rel.PublishedAt
	info.UpdateAvailable = compareVersions(latest, version) > 0

	return info, nil
}

// compareVersions compares dotted numeric versions, ignoring any pre-release or
// build suffix. Returns -1 if a < b, 0 if equal, 1 if a > b.
func compareVersions(a, b string) int {
	as := versionParts(a)
	bs := versionParts(b)
	for i := 0; i < len(as) || i < len(bs); i++ {
		var av, bv int
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if av != bv {
			if av < bv {
				return -1
			}
			return 1
		}
	}
	return 0
}

func versionParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	fields := strings.Split(v, ".")
	parts := make([]int, 0, len(fields))
	for _, f := range fields {
		n, err := strconv.Atoi(strings.TrimSpace(f))
		if err != nil {
			n = 0
		}
		parts = append(parts, n)
	}
	return parts
}
