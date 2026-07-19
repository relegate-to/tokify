//go:build darwin

package main

import (
	"context"
	stderrors "errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/systray"
	"github.com/go-faster/errors"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	exportapp "github.com/kriuchkov/tock/internal/app/export"
	projectreg "github.com/kriuchkov/tock/internal/app/projects"
	"github.com/kriuchkov/tock/internal/app/runtime"
	teamreg "github.com/kriuchkov/tock/internal/app/teams"
	"github.com/kriuchkov/tock/internal/appdir"
	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonauth"
	"github.com/kriuchkov/tock/internal/integrations/neonsync"
	"github.com/kriuchkov/tock/internal/integrations/teams"
	"github.com/kriuchkov/tock/internal/timeutil"
)

// App is the Wails-bound surface for the Tokify desktop window. It owns a tock
// Runtime so the GUI talks to the same services and the same data file the
// `tock` CLI does — there is no parallel implementation of any business rule.
type App struct {
	ctx      context.Context
	rt       *runtime.Runtime
	teams    *teams.Service
	neonAuth *neonauth.Service
	neonSync *neonsync.Service
	projects *projectreg.Registry
	// teamNames is the client-side audience-id -> local name map for sharing
	// teams (distinct from the Microsoft Teams integration in `teams` above).
	teamNames *teamreg.Registry
	// sharedCache serves the last-good decrypted shared activity instantly while a
	// refresh runs in the background — see sharedCache and refreshSharedAsync.
	sharedCache *sharedCache

	mu       sync.Mutex
	trayStop chan struct{}
	syncKick chan struct{}

	teamsReconnecting atomic.Bool
	syncing           atomic.Bool
	sharedRefreshing  atomic.Bool
}

// Encrypted sync runs on its own without the user clicking "Sync now": once
// shortly after launch (to pull whatever other devices pushed while this one
// was closed) and then on a steady interval.
const (
	syncStartupDelay = 5 * time.Second
	syncInterval     = 5 * time.Minute
	// syncDebounce is how long syncSoon waits after the last mutation before
	// syncing, so a burst of edits collapses into a single round-trip.
	syncDebounce = 2 * time.Second
)

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// A TOKIFY_PROFILE-namespaced log (see internal/appdir) lets two signed-in
	// users run side by side for local sharing tests; empty means the upstream
	// default (~/.tock.txt, or TOCK_FILE).
	rt, err := runtime.Load(ctx, runtime.Request{FilePath: appdir.LogPath()})
	if err != nil {
		return
	}
	a.rt = rt
	// The project registry gives projects a first-class existence independent of
	// the activity log (see internal/app/projects). Non-fatal on error, like the
	// other Tokify-side state files — a failure means we can't reach ~/Library.
	if p, perr := projectreg.DefaultPath(); perr == nil {
		if reg, oerr := projectreg.Open(p); oerr == nil {
			a.projects = reg
		}
	}
	// Sharing team names are client-side only (the server never sees them); same
	// non-fatal open as the project registry.
	if p, perr := teamreg.DefaultPath(); perr == nil {
		if reg, oerr := teamreg.Open(p); oerr == nil {
			a.teamNames = reg
		}
	}
	// The shared-activity cache paints the merged Activity view from the previous
	// session's rows before the first network read returns. Non-fatal like the
	// registries — a failure just means we can't reach ~/Library and cold starts
	// stay slow.
	if p, perr := sharedCachePath(); perr == nil {
		a.sharedCache = openSharedCache(p)
	}
	// Teams integration is opt-in; we still construct the service eagerly so
	// the settings page can render its disabled state without a round-trip
	// failure. A construction error means we can't reach ~/Library, which
	// would block far more than Teams — log and continue.
	if t, err := teams.NewService(); err == nil {
		a.teams = t
	}
	// Neon Auth is optional and never gates core tracking; construct it eagerly
	// so the Account view can render its signed-out / unconfigured state without
	// a round-trip failure. A construction error means we can't reach ~/Library.
	if n, err := neonauth.NewService(); err == nil {
		a.neonAuth = n
	}
	// Encrypted sync builds on Neon Auth (bearer token) and the tock runtime
	// (the activity log it mirrors). Optional, so a construction error is
	// non-fatal — the Account panel renders its unconfigured state.
	if a.neonAuth != nil {
		if sync, err := neonsync.NewService(rt.ActivityService, a.neonAuth); err == nil {
			a.neonSync = sync
			if a.neonAuth.Status().SignedIn {
				a.forceSyncEnabled()
			}
			a.syncKick = make(chan struct{}, 1)
			go a.autoSyncLoop()
			go a.syncDebouncer()
		}
	}
}

// autoSyncLoop keeps the cloud mirror fresh in the background. Every fire is
// best-effort and quiet: offline, locked, disabled, and signed-out states are
// all skipped and errors never surface, matching how manual sync degrades. The
// loop lives for the app's lifetime and unwinds when the Wails context is
// cancelled on shutdown.
func (a *App) autoSyncLoop() {
	timer := time.NewTimer(syncStartupDelay)
	defer timer.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-timer.C:
			a.autoSyncOnce()
			timer.Reset(syncInterval)
		}
	}
}

// syncDebouncer coalesces mutation-driven sync requests. A kick (re)arms a short
// window; when it elapses the app syncs once. If a sync was already in flight the
// window re-arms so a mutation made mid-sync still propagates rather than waiting
// for the next interval tick. Lives for the app's lifetime alongside
// autoSyncLoop.
func (a *App) syncDebouncer() {
	var window <-chan time.Time
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-a.syncKick:
			window = time.After(syncDebounce)
		case <-window:
			window = nil
			if !a.autoSyncOnce() {
				window = time.After(syncDebounce)
			}
		}
	}
}

// syncSoon asks the debouncer to sync shortly after the current burst of
// mutations settles. Best-effort and non-blocking: the buffered kick channel
// coalesces rapid calls, and it no-ops before the debouncer exists (sync not
// configured).
func (a *App) syncSoon() {
	if a.syncKick == nil {
		return
	}
	select {
	case a.syncKick <- struct{}{}:
	default:
	}
}

// autoSyncOnce runs a single background sync if one is warranted. It shares the
// syncing guard with manual SyncNow so background ticks never stack on each
// other or collide with a user-initiated sync, and it emits sync:updated so the
// Account card refreshes without the panel being reopened.
//
// The bool reports whether the caller should try again shortly: false only when
// a sync was already in flight (the debouncer re-arms so a mutation made during
// that sync still propagates); true in every other case, including the quiet
// skips (disabled, locked, offline) where retrying would be pointless.
func (a *App) autoSyncOnce() bool {
	if a.neonSync == nil {
		return true
	}
	st := a.neonSync.Status()
	if !st.Enabled || !st.Unlocked {
		return true
	}
	if !a.syncing.CompareAndSwap(false, true) {
		return false
	}
	defer a.syncing.Store(false)

	ctx, cancel := context.WithTimeout(a.ctx, 90*time.Second)
	defer cancel()
	status, err := a.neonSync.SyncNow(ctx)
	if err != nil {
		return true
	}
	a.refreshTrayTitle()
	wailsruntime.EventsEmit(a.ctx, "sync:updated", status)
	return true
}

// trayOnReady builds the status bar menu. Called by systray on the main
// thread once the NSStatusItem exists. The window-hide path is handled by
// Wails' HideWindowOnClose at the Cocoa layer, so the tray only needs to
// surface "show" and "quit" — no toggle state to keep in sync.
func (a *App) trayOnReady() {
	systray.SetTitle(" ○")
	systray.SetTooltip("Tokify")

	show := systray.AddMenuItem("Show Tokify", "Bring the Tokify window to the front")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit Tokify", "Quit Tokify")

	a.mu.Lock()
	a.trayStop = make(chan struct{})
	stop := a.trayStop
	a.mu.Unlock()

	go a.trayLoop(show.ClickedCh, quit.ClickedCh, stop)
}

func (a *App) trayOnExit() {
	a.mu.Lock()
	stop := a.trayStop
	a.trayStop = nil
	a.mu.Unlock()
	if stop != nil {
		close(stop)
	}
}

// trayLoop dispatches tray clicks and re-renders the title on each minute
// boundary so the displayed M:SS flips exactly when it changes value.
// Mutations (Start/Stop/…) call refreshTrayTitle directly. The loop waits for
// startup to populate a.ctx before issuing any Wails runtime calls — the tray
// goroutine and Wails startup race otherwise.
func (a *App) trayLoop(showCh, quitCh <-chan struct{}, stop <-chan struct{}) {
	for a.ctx == nil {
		select {
		case <-stop:
			return
		case <-time.After(100 * time.Millisecond):
		}
	}

	a.refreshTrayTitle()
	nextMinute := func() time.Duration {
		return time.Until(time.Now().Truncate(time.Minute).Add(time.Minute))
	}
	timer := time.NewTimer(nextMinute())
	defer timer.Stop()

	for {
		select {
		case <-stop:
			return
		case <-timer.C:
			a.refreshTrayTitle()
			timer.Reset(nextMinute())
		case <-showCh:
			wailsruntime.WindowShow(a.ctx)
		case <-quitCh:
			wailsruntime.Quit(a.ctx)
			return
		}
	}
}

func (a *App) refreshTrayTitle() {
	act, err := a.GetRunning()
	if err != nil || act == nil {
		systray.SetTitle(" ○")
		return
	}
	systray.SetTitle(" ● " + formatElapsed(time.Since(act.StartTime)))
}

func formatElapsed(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	mins := int(d.Minutes())
	h := mins / 60
	m := mins % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d", h, m)
	}
	return fmt.Sprintf("0:%02d", m)
}

func (a *App) requireRuntime() error {
	if a.rt == nil {
		return errors.New("tokify couldn't reach the tock data file")
	}
	return nil
}

// GetRunning returns the activity currently being tracked, or nil if nothing
// is running. The window's hero state.
func (a *App) GetRunning() (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	running := true
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{IsRunning: &running})
	if err != nil {
		return nil, err
	}
	if len(acts) == 0 {
		return nil, nil
	}
	// Pick the latest start time in case multiple slipped through.
	latest := acts[0]
	for _, act := range acts[1:] {
		if act.StartTime.After(latest.StartTime) {
			latest = act
		}
	}
	return &latest, nil
}

// ListToday returns activities that started today, oldest first — the order
// you read a logbook.
func (a *App) ListToday() ([]models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	now := time.Now()
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	to := from.Add(24 * time.Hour)
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{FromDate: &from, ToDate: &to})
	if err != nil {
		return nil, err
	}
	return acts, nil
}

// ListPastYear returns activities that started during the last 365 local days.
func (a *App) ListPastYear() ([]models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	now := time.Now()
	to := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, 1)
	from := to.AddDate(0, 0, -365)
	return a.rt.ActivityService.List(a.ctx, models.ActivityFilter{FromDate: &from, ToDate: &to})
}

// Start begins a new activity. Description is required; project is optional.
// Starting a new one stops anything already running (tock's own behavior).
func (a *App) Start(description, project string) (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("describe what you're working on")
	}
	act, err := a.rt.ActivityService.Start(a.ctx, models.StartActivityRequest{
		Description: description,
		Project:     strings.TrimSpace(project),
	})
	if err == nil {
		a.refreshTrayTitle()
		a.pushTeamsStatus(description, strings.TrimSpace(project))
		a.syncSoon()
	}
	return act, err
}

// StartAt begins a new activity with an explicit start time — for when the
// user forgot to start tracking earlier. Otherwise identical to Start.
func (a *App) StartAt(description, project, startISO string) (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("describe what you're working on")
	}
	start, err := time.Parse(time.RFC3339, strings.TrimSpace(startISO))
	if err != nil {
		return nil, errors.Wrap(err, "parse start time")
	}
	if start.After(time.Now()) {
		return nil, errors.New("start time must be in the past")
	}
	act, err := a.rt.ActivityService.Start(a.ctx, models.StartActivityRequest{
		Description: description,
		Project:     strings.TrimSpace(project),
		StartTime:   start,
	})
	if err == nil {
		a.refreshTrayTitle()
		a.pushTeamsStatus(description, strings.TrimSpace(project))
		a.syncSoon()
	}
	return act, err
}

// AddActivity creates a completed activity with arbitrary start and end times —
// for back-filling tracked work that wasn't recorded live.
func (a *App) AddActivity(description, project, startISO, endISO string) (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("describe what you were working on")
	}
	start, err := time.Parse(time.RFC3339, strings.TrimSpace(startISO))
	if err != nil {
		return nil, errors.Wrap(err, "parse start time")
	}
	end, err := time.Parse(time.RFC3339, strings.TrimSpace(endISO))
	if err != nil {
		return nil, errors.Wrap(err, "parse end time")
	}
	if !end.After(start) {
		return nil, errors.New("end must be after start")
	}
	act, err := a.rt.ActivityService.Add(a.ctx, models.AddActivityRequest{
		Description: description,
		Project:     strings.TrimSpace(project),
		StartTime:   start,
		EndTime:     end,
	})
	if err == nil {
		a.syncSoon()
	}
	return act, err
}

// Stop ends the running activity.
func (a *App) Stop() (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	act, err := a.rt.ActivityService.Stop(a.ctx, models.StopActivityRequest{})
	if err == nil {
		a.refreshTrayTitle()
		// Empty description signals "clear my Teams status" — but we still
		// need the just-stopped activity's project so the integration's
		// allowlist check matches.
		project := ""
		if act != nil {
			project = act.Project
		}
		a.pushTeamsStatus("", project)
		a.syncSoon()
	}
	return act, err
}

// UpdateActivity edits an existing activity. Description and project change
// in place. Start and end times may also change: if startISO differs from the
// original start, the activity is moved to the new start time (the repo's
// key) by removing the original row and saving under the new key. End time
// changes are applied in place.
func (a *App) UpdateActivity(orig models.Activity, description, project, startISO, endISO string) (*models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" {
		return nil, errors.New("describe what you were working on")
	}
	updated := orig
	updated.Description = description
	updated.Project = strings.TrimSpace(project)

	newStart := orig.StartTime
	if s := strings.TrimSpace(startISO); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return nil, errors.Wrap(err, "parse start time")
		}
		newStart = t
	}

	newEnd := updated.EndTime
	if s := strings.TrimSpace(endISO); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return nil, errors.Wrap(err, "parse end time")
		}
		newEnd = &t
	}

	if newEnd != nil && newStart.After(*newEnd) {
		return nil, errors.New("start must not be after end")
	}

	if !newStart.Equal(orig.StartTime) {
		if err := a.rt.ActivityService.Remove(a.ctx, orig); err != nil {
			return nil, err
		}
		updated.StartTime = newStart
	}
	updated.EndTime = newEnd

	if err := a.rt.ActivityRepo.Save(a.ctx, updated); err != nil {
		return nil, err
	}
	// An edit changes the entry's content id, orphaning the pre-edit row in the
	// cloud. Tombstone the original so sync deletes it instead of resurrecting the
	// stale copy; a no-op edit is dropped as a stale tombstone on the next sync.
	if a.neonSync != nil {
		_ = a.neonSync.RecordDeletion(orig)
		a.syncSoon()
	}
	a.refreshTrayTitle()
	return &updated, nil
}

// RemoveActivity deletes an activity.
func (a *App) RemoveActivity(orig models.Activity) error {
	if err := a.requireRuntime(); err != nil {
		return err
	}
	if err := a.rt.ActivityService.Remove(a.ctx, orig); err != nil {
		return err
	}
	if a.neonSync != nil {
		_ = a.neonSync.RecordDeletion(orig)
		a.syncSoon()
	}
	a.refreshTrayTitle()
	return nil
}

// ListRecent returns up to `limit` activities, newest start time first,
// without deduplication — the historical stream the logbook browses.
func (a *App) ListRecent(limit int) ([]models.Activity, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 200
	}
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{})
	if err != nil {
		return nil, err
	}
	sort.Slice(acts, func(i, j int) bool {
		return acts[i].StartTime.After(acts[j].StartTime)
	})
	if len(acts) > limit {
		acts = acts[:limit]
	}
	return acts, nil
}

// Export renders the activity log as txt, csv, or json, prompts the user for a
// destination path via the native save dialog, and writes the file. Returns
// the saved path, or an empty string if the user cancelled. fromDate and
// toDate are YYYY-MM-DD strings (either may be empty for an open-ended range);
// project filters by exact project name (empty means no project filter).
// Reuses tock's own RenderOutput so the GUI and CLI produce byte-identical
// exports.
func (a *App) Export(format, fromDate, toDate, project string, includeShared bool) (string, error) {
	if err := a.requireRuntime(); err != nil {
		return "", err
	}
	format = strings.ToLower(strings.TrimSpace(format))
	switch format {
	case "txt", "csv", "json":
	default:
		return "", errors.Errorf("unsupported format: %s", format)
	}

	opts := models.ActivityFilterOptions{
		Now:     time.Now(),
		Project: strings.TrimSpace(project),
	}
	if s := strings.TrimSpace(fromDate); s != "" {
		t, err := time.ParseInLocation("2006-01-02", s, time.Local)
		if err != nil {
			return "", errors.Wrap(err, "invalid from date (use YYYY-MM-DD)")
		}
		opts.FromDate = &t
	}
	if s := strings.TrimSpace(toDate); s != "" {
		t, err := time.ParseInLocation("2006-01-02", s, time.Local)
		if err != nil {
			return "", errors.Wrap(err, "invalid to date (use YYYY-MM-DD)")
		}
		_, end := timeutil.LocalDayBounds(t)
		opts.ToDate = &end
	}
	if opts.FromDate != nil && opts.ToDate != nil && opts.FromDate.After(*opts.ToDate) {
		return "", errors.New("from date must not be after to date")
	}

	filter, err := models.BuildActivityFilter(opts)
	if err != nil {
		return "", errors.Wrap(err, "build filter")
	}
	report, err := a.rt.ActivityService.GetReport(a.ctx, filter)
	if err != nil {
		return "", errors.Wrap(err, "generate report")
	}
	// Opt-in: fold read-only shared activity from other members into the export.
	// Default (own-only) leaves the report as the local log, so a teammate's data
	// never lands in an export unless the user asked for it.
	if includeShared && a.sharedCache != nil {
		cached := a.sharedCache.get()
		shared := make([]models.Activity, 0, len(cached))
		for _, s := range cached {
			shared = append(shared, s.Activity)
		}
		foldSharedIntoReport(report, shared, filter)
	}
	output, err := exportapp.RenderOutput(format, report, a.rt.TimeFormatter)
	if err != nil {
		return "", errors.Wrap(err, "render output")
	}

	defaultDir, _ := a.rt.DefaultExportDir()
	defaultName := "tokify-report-" + time.Now().Format("20060102-150405") + "." + format

	path, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:            "Export Tokify Activities",
		DefaultDirectory: defaultDir,
		DefaultFilename:  defaultName,
		Filters: []wailsruntime.FileFilter{
			{DisplayName: strings.ToUpper(format) + " (*." + format + ")", Pattern: "*." + format},
		},
	})
	if err != nil {
		return "", errors.Wrap(err, "save dialog")
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, output, 0600); err != nil {
		return "", errors.Wrap(err, "write file")
	}
	return path, nil
}

// TeamsGetStatus returns connection + preference state for the settings UI.
// Always returns a Status; absence is reported via Connected=false, never as
// an error.
func (a *App) TeamsGetStatus() teams.Status {
	if a.teams == nil {
		return teams.Status{}
	}
	return a.teams.Status()
}

// TeamsSetEnabled flips the master switch. Doesn't touch stored tokens — the
// user can disable temporarily without re-doing the OAuth dance.
func (a *App) TeamsSetEnabled(enabled bool) error {
	if a.teams == nil {
		return errors.New("teams integration unavailable")
	}
	return a.teams.SetEnabled(enabled)
}

// TeamsSetTrackedProjects replaces the project allowlist. Activities under
// projects not in this list are never reflected in Teams status.
func (a *App) TeamsSetTrackedProjects(projects []string) error {
	if a.teams == nil {
		return errors.New("teams integration unavailable")
	}
	return a.teams.SetTrackedProjects(projects)
}

// TeamsConnect runs the full sign-in flow by spawning the tock-teams-auth
// helper subprocess for each audience. The helper opens a real WKWebView
// window for the user and silently captures the redirect; this binding
// resolves once all three tokens are in Keychain (or rejects on cancel /
// failure). Blocks the calling goroutine for the duration; the frontend
// should show a busy state while it runs.
func (a *App) TeamsConnect() error {
	if a.teams == nil {
		return errors.New("teams integration unavailable")
	}
	// Bound the whole dance so a stuck sign-in can't pin a goroutine forever.
	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Minute)
	defer cancel()
	return a.teams.Connect(ctx)
}

// TeamsDisconnect deletes all stored tokens. Preferences survive so the next
// connect doesn't lose the project allowlist.
func (a *App) TeamsDisconnect() error {
	if a.teams == nil {
		return errors.New("teams integration unavailable")
	}
	return a.teams.Disconnect(a.ctx)
}

// AuthStatus returns the Neon Auth configuration + sign-in snapshot for the
// Account view. Always returns a Status; absence of a session is reported via
// SignedIn=false, never as an error.
func (a *App) AuthStatus() neonauth.Status {
	if a.neonAuth == nil {
		return neonauth.Status{}
	}
	return a.neonAuth.Status()
}

// ApplicationDataDirectory returns the profile-aware directory containing
// Tokify's local JSON settings and cache files.
func (a *App) ApplicationDataDirectory() (string, error) {
	return appdir.Dir()
}

// OpenApplicationDataDirectory creates the local data directory when needed
// and reveals it in Finder.
func (a *App) OpenApplicationDataDirectory() error {
	dir, err := a.ApplicationDataDirectory()
	if err != nil {
		return errors.Wrap(err, "get application data directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.Wrap(err, "create application data directory")
	}
	if err := exec.Command("open", dir).Run(); err != nil {
		return errors.Wrap(err, "open application data directory")
	}
	return nil
}

// ActivityLogPath returns the active local activity-log path. It is normally
// ~/.tock.txt, though it can be changed through Tokify's runtime configuration.
func (a *App) ActivityLogPath() (string, error) {
	if a.rt == nil || strings.TrimSpace(a.rt.DataPath) == "" {
		return "", errors.New("activity log unavailable")
	}
	return a.rt.DataPath, nil
}

// OpenActivityLog reveals the active activity log in Finder.
func (a *App) OpenActivityLog() error {
	path, err := a.ActivityLogPath()
	if err != nil {
		return err
	}
	if err := exec.Command("open", "-R", path).Run(); err != nil {
		return errors.Wrap(err, "reveal activity log")
	}
	return nil
}

// AuthSignIn authenticates with email + password and persists the session in
// Keychain. Returns the resulting Status.
//
// The raw password never reaches the server: Neon Auth receives a derived hash
// (H_auth), while the raw password is used locally to unlock encrypted sync.
// Sending the same value for both would hand the server the encryption key, so
// the two derivations are deliberately domain-separated.
func (a *App) AuthSignIn(email, password string) (neonauth.Status, error) {
	if a.neonAuth == nil {
		return neonauth.Status{}, errors.New("auth unavailable")
	}
	email = strings.TrimSpace(email)
	authHash, err := neonsync.DeriveAuthHash(email, password)
	if err != nil {
		return neonauth.Status{}, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	status, err := a.neonAuth.SignIn(ctx, email, authHash)
	if err != nil {
		return status, err
	}
	a.unlockSync(ctx, email, password, status.UserID)
	return status, nil
}

// AuthSignUp creates an account with email + password and persists the session.
// Like sign-in, Neon Auth gets the derived hash, not the raw password.
func (a *App) AuthSignUp(email, password, name string) (neonauth.Status, error) {
	if a.neonAuth == nil {
		return neonauth.Status{}, errors.New("auth unavailable")
	}
	email = strings.TrimSpace(email)
	authHash, err := neonsync.DeriveAuthHash(email, password)
	if err != nil {
		return neonauth.Status{}, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	status, err := a.neonAuth.SignUp(ctx, email, authHash, strings.TrimSpace(name))
	if err != nil {
		return status, err
	}
	// When email verification is required, sign-up yields no session yet; there
	// is nothing to unlock until AuthVerifyEmail establishes one.
	if status.SignedIn {
		a.unlockSync(ctx, email, password, status.UserID)
	}
	return status, nil
}

// AuthVerifyEmail confirms the code Neon Auth emailed after sign-up and, on
// success, signs in to establish the session. Sync is then unlocked with the
// raw password exactly as in AuthSignIn.
func (a *App) AuthVerifyEmail(email, password, code string) (neonauth.Status, error) {
	if a.neonAuth == nil {
		return neonauth.Status{}, errors.New("auth unavailable")
	}
	email = strings.TrimSpace(email)
	authHash, err := neonsync.DeriveAuthHash(email, password)
	if err != nil {
		return neonauth.Status{}, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	status, err := a.neonAuth.VerifyEmail(ctx, email, authHash, strings.TrimSpace(code))
	if err != nil {
		return status, err
	}
	if status.SignedIn {
		a.unlockSync(ctx, email, password, status.UserID)
	}
	return status, nil
}

// AuthResendVerification asks Neon Auth to email a fresh verification code.
func (a *App) AuthResendVerification(email string) error {
	if a.neonAuth == nil {
		return errors.New("auth unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.neonAuth.ResendVerification(ctx, strings.TrimSpace(email))
}

// unlockSync provisions or recovers the sync encryption key from the password.
// Best-effort: a failure here (offline, sync unconfigured) must not fail an
// otherwise-successful sign-in, so it is logged and swallowed.
func (a *App) unlockSync(ctx context.Context, email, password, userID string) {
	if a.neonSync == nil {
		return
	}
	a.forceSyncEnabled()
	token, err := a.neonAuth.Token(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "neonsync: mint data-api token: %v\n", err)
		return
	}
	if err := a.neonSync.Unlock(ctx, email, password, userID, token); err != nil {
		fmt.Fprintf(os.Stderr, "neonsync: unlock: %v\n", err)
		return
	}
	a.publishSelfName(ctx)
}

// forceSyncEnabled keeps sync on for every signed-in session. A failure to
// persist the preference is non-fatal to sign-in; the in-memory setting is
// still enabled and the next successful write will persist it.
func (a *App) forceSyncEnabled() {
	if a.neonSync == nil {
		return
	}
	if err := a.neonSync.SetEnabled(true); err != nil {
		fmt.Fprintf(os.Stderr, "neonsync: enable: %v\n", err)
	}
}

// publishSelfName best-effort republishes the signed-in user's name (from the
// auth profile) onto their sharing identity, so anyone who sees them resolves a
// name rather than an id: a team roster, or — the reverse of that — an invitee
// reading who invited them. Called on unlock and before any invite/create action
// so the name is present the moment someone else needs it. A failure (sharing
// locked, offline) is ignored; the next call retries.
func (a *App) publishSelfName(ctx context.Context) {
	if a.neonSync == nil || a.neonAuth == nil {
		return
	}
	name := strings.TrimSpace(a.neonAuth.Status().Name)
	if name == "" {
		return
	}
	if err := a.neonSync.PublishDisplayName(ctx, name); err != nil {
		fmt.Fprintf(os.Stderr, "neonsync: publish display name: %v\n", err)
	}
}

// AuthSignOut revokes the session, clears the stored token, and locks sync by
// discarding the cached encryption key.
func (a *App) AuthSignOut() error {
	if a.neonAuth == nil {
		return errors.New("auth unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	if a.neonSync != nil {
		_ = a.neonSync.Lock(ctx)
	}
	// Drop the on-disk shared-activity cache so another member's decrypted rows
	// don't linger past sign-out.
	if a.sharedCache != nil {
		a.sharedCache.clear()
	}
	return a.neonAuth.SignOut(ctx)
}

// SyncStatus returns the encrypted-sync configuration + last-sync snapshot for
// the Account panel. Always returns a status; never errors.
func (a *App) SyncStatus() neonsync.SyncStatus {
	if a.neonSync == nil {
		return neonsync.SyncStatus{}
	}
	return a.neonSync.Status()
}

// SyncSetEnabled is retained for compatibility with the desktop binding. Sync
// cannot be disabled while a user is signed in.
func (a *App) SyncSetEnabled(enabled bool) (neonsync.SyncStatus, error) {
	if a.neonSync == nil {
		return neonsync.SyncStatus{}, errors.New("sync unavailable")
	}
	if !enabled && a.neonAuth != nil && a.neonAuth.Status().SignedIn {
		return a.neonSync.Status(), errors.New("sync must remain enabled while signed in")
	}
	if err := a.neonSync.SetEnabled(enabled); err != nil {
		return a.neonSync.Status(), err
	}
	return a.neonSync.Status(), nil
}

// SyncNow runs a push+pull cycle and returns the updated status.
func (a *App) SyncNow() (neonsync.SyncStatus, error) {
	if a.neonSync == nil {
		return neonsync.SyncStatus{}, errors.New("sync unavailable")
	}
	// If a background sync is mid-flight, don't run a second one on top of it;
	// the in-flight sync produces the same result, so report its current status.
	if !a.syncing.CompareAndSwap(false, true) {
		return a.neonSync.Status(), nil
	}
	defer a.syncing.Store(false)

	ctx, cancel := context.WithTimeout(a.ctx, 90*time.Second)
	defer cancel()
	status, err := a.neonSync.SyncNow(ctx)
	if err == nil {
		a.refreshTrayTitle()
	}
	return status, err
}

// SharingCreateLink creates a capability link over a project/time filter.
func (a *App) SharingCreateLink(projects []string, sinceDays, validForHours int) (neonsync.LinkShare, error) {
	if a.neonSync == nil {
		return neonsync.LinkShare{}, errors.New("sharing unavailable")
	}
	if sinceDays < 0 {
		return neonsync.LinkShare{}, errors.New("since days must be non-negative")
	}
	if validForHours < 0 {
		return neonsync.LinkShare{}, errors.New("valid-for hours must be non-negative")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 90*time.Second)
	defer cancel()
	return a.neonSync.CreateLinkShare(ctx, projects, sinceDays, time.Duration(validForHours)*time.Hour)
}

// SharingListLinks returns active capability links owned by the signed-in user.
func (a *App) SharingListLinks() ([]neonsync.LinkShareInfo, error) {
	if a.neonSync == nil {
		return nil, errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.neonSync.ListLinkShares(ctx)
}

// SharingRevokeLink revokes a capability link and deletes its backing audience.
func (a *App) SharingRevokeLink(audienceID string) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.neonSync.RevokeLinkShare(ctx, strings.TrimSpace(audienceID))
}

// pushTeamsStatus fires the Teams status update off the activity-write path.
// We never block the user's Start/Stop on a network call, and we never
// surface a Teams failure as a Start/Stop failure — the time log is the
// source of truth, the integration is decoration.
//
// If silent re-auth has failed (refresh + prompt=none both dead), we pop the
// real sign-in window automatically rather than asking the user to navigate
// to Settings → Teams → Connect. Guarded against duplicate windows when
// pushes overlap.
func (a *App) pushTeamsStatus(description, project string) {
	if a.teams == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := a.teams.PushActivityStatus(ctx, description, project)
		if err == nil {
			return
		}
		if stderrors.Is(err, teams.ErrInteractionRequired) {
			go a.reconnectAndRetry(description, project)
			return
		}
		// Toast on the main window so the user sees Teams problems but
		// doesn't conflate them with tracking problems.
		wailsruntime.EventsEmit(a.ctx, "teams:error", err.Error())
	}()
}

// reconnectAndRetry pops the interactive sign-in window and, on success,
// retries the status push that triggered it. The atomic guard prevents
// stacked Start/Stop events from spawning multiple WKWebView windows.
func (a *App) reconnectAndRetry(description, project string) {
	if !a.teamsReconnecting.CompareAndSwap(false, true) {
		return
	}
	defer a.teamsReconnecting.Store(false)

	connectCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := a.teams.Connect(connectCtx); err != nil {
		wailsruntime.EventsEmit(a.ctx, "teams:error", err.Error())
		return
	}
	pushCtx, pushCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pushCancel()
	if err := a.teams.PushActivityStatus(pushCtx, description, project); err != nil {
		wailsruntime.EventsEmit(a.ctx, "teams:error", err.Error())
	}
}

// Projects returns distinct project names seen recently — feeds the small-caps
// hint chip below the input.
func (a *App) Projects() ([]string, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	recent, err := a.rt.ActivityService.GetRecent(a.ctx, 100)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	out := []string{}
	for _, act := range recent {
		p := strings.TrimSpace(act.Project)
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
		if len(out) >= 8 {
			break
		}
	}
	return out, nil
}

// ListProjects returns the authoritative catalog of projects: the union of
// explicitly-created projects and every project name ever seen in the activity
// log, which are auto-registered on read so the list stays stable. Unlike
// Projects (recent names for autocomplete), this is what the sharing and team
// UIs build on — including projects with no time tracked against them yet.
func (a *App) ListProjects() ([]projectreg.Project, error) {
	if err := a.requireRuntime(); err != nil {
		return nil, err
	}
	if a.projects == nil {
		return nil, errors.New("project registry unavailable")
	}
	acts, err := a.rt.ActivityService.List(a.ctx, models.ActivityFilter{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(acts))
	for _, act := range acts {
		names = append(names, act.Project)
	}
	if eerr := a.projects.Ensure(names...); eerr != nil {
		return nil, eerr
	}
	return a.projects.List(), nil
}

// CreateProject registers a project that may have no time tracked against it
// yet, so a sharing team can be assembled before work begins. Idempotent.
func (a *App) CreateProject(name string) (projectreg.Project, error) {
	if a.projects == nil {
		return projectreg.Project{}, errors.New("project registry unavailable")
	}
	return a.projects.Create(name)
}

// TeamView is a sharing team (an audience) joined with its client-side name.
// The server never stores the name, so the Teams UI reads it from teamNames.
type TeamView struct {
	neonsync.TeamInfo
	Name string
}

// SharingCreateTeam creates a new sharing audience and names it locally. The new
// team is an audience of one (the caller, as admin) on epoch 1 until members are
// invited.
func (a *App) SharingCreateTeam(name string) (TeamView, error) {
	if a.neonSync == nil {
		return TeamView{}, errors.New("sharing unavailable")
	}
	if a.teamNames == nil {
		return TeamView{}, errors.New("team registry unavailable")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return TeamView{}, errors.New("team name is empty")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	a.publishSelfName(ctx)
	id, err := a.neonSync.CreateAudience(ctx)
	if err != nil {
		return TeamView{}, err
	}
	t, err := a.teamNames.SetName(id, name)
	if err != nil {
		return TeamView{}, err
	}
	// Publish the name encrypted to the audience so invitees see it (not
	// "Untitled"). Best-effort: the local name already covers the creator, and a
	// rename retries the publish, so a transient failure must not fail creation.
	_ = a.neonSync.SetTeamName(ctx, id, name)
	return TeamView{
		TeamInfo: neonsync.TeamInfo{ID: id, Role: "admin", MemberCount: 1, CurrentEpoch: 1},
		Name:     t.Name,
	}, nil
}

// SharingListTeams returns the caller's sharing teams joined with their local
// names (empty for a team this device hasn't named yet).
func (a *App) SharingListTeams() ([]TeamView, error) {
	if a.neonSync == nil {
		return nil, errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	infos, err := a.neonSync.ListAudiences(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]TeamView, 0, len(infos))
	for _, info := range infos {
		// Prefer a device-local name (a rename this device made) over the
		// creator's encrypted shared name; fall back to the shared name so a
		// joiner sees the real team name instead of "Untitled".
		name := ""
		if a.teamNames != nil {
			name = a.teamNames.Name(info.ID)
		}
		if name == "" {
			name = info.SharedName
		}
		out = append(out, TeamView{TeamInfo: info, Name: name})
	}
	return out, nil
}

// SharingTeamMembers returns one team's roster with each member's pin status.
func (a *App) SharingTeamMembers(audienceID string) ([]neonsync.TeamMember, error) {
	if a.neonSync == nil {
		return nil, errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.neonSync.ListMembers(ctx, strings.TrimSpace(audienceID))
}

// SharingProjectShares returns, per shared project, who can see it (the teammates
// and the teams sharing it, minus the caller), for the shared-with hover card on
// a project badge. Sharing being unavailable is not an error here: the badge is
// decorative, so it simply returns nothing.
func (a *App) SharingProjectShares() ([]neonsync.ProjectShare, error) {
	if a.neonSync == nil {
		return []neonsync.ProjectShare{}, nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.neonSync.ProjectShares(ctx)
}

// SharingDeleteTeam deletes a team the caller created (server-side cascade) and
// drops its local name. Only the creator can delete; a non-creator admin gets a
// permission error from the server.
func (a *App) SharingDeleteTeam(audienceID string) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	id := strings.TrimSpace(audienceID)
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	if err := a.neonSync.DeleteAudience(ctx, id); err != nil {
		return err
	}
	if a.teamNames != nil {
		_ = a.teamNames.Remove(id)
	}
	return nil
}

// SharingLeaveTeam removes the caller from a team they belong to but did not
// create, and drops its local name. Unlike delete, this only touches the caller's
// own membership; the team lives on for everyone else.
func (a *App) SharingLeaveTeam(audienceID string) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	id := strings.TrimSpace(audienceID)
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	if err := a.neonSync.LeaveAudience(ctx, id); err != nil {
		return err
	}
	if a.teamNames != nil {
		_ = a.teamNames.Remove(id)
	}
	return nil
}

// SharingAcceptInvite accepts a pending team invitation: the caller's membership
// flips from invited to active, and only then do the team's shared entries and
// roster become visible to them. A sync is kicked so the newly readable slice
// reconciles into their view.
func (a *App) SharingAcceptInvite(audienceID string) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	if err := a.neonSync.AcceptInvite(ctx, strings.TrimSpace(audienceID)); err != nil {
		return err
	}
	a.syncSoon()
	return nil
}

// SharingDeclineInvite declines a pending invitation by removing the caller's own
// (still-pending) membership row. It is the same self-delete as leaving a team,
// framed for an invite the caller never accepted; any local name is dropped too.
func (a *App) SharingDeclineInvite(audienceID string) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	id := strings.TrimSpace(audienceID)
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	if err := a.neonSync.LeaveAudience(ctx, id); err != nil {
		return err
	}
	if a.teamNames != nil {
		_ = a.teamNames.Remove(id)
	}
	return nil
}

// SharingRenameTeam updates the team name: the device-local name always, and —
// when the caller is an admin — the encrypted shared name so other members see
// the new name too. A non-admin's shared-name write is refused by RLS, which is
// fine: their rename stays local to this device.
func (a *App) SharingRenameTeam(audienceID, name string) error {
	if a.teamNames == nil {
		return errors.New("team registry unavailable")
	}
	if _, err := a.teamNames.SetName(audienceID, name); err != nil {
		return err
	}
	if a.neonSync != nil {
		ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
		defer cancel()
		_ = a.neonSync.SetTeamName(ctx, strings.TrimSpace(audienceID), name)
	}
	return nil
}

// SharingAddMember adds a user to a team by their user id, pinning their
// identity on first sight (TOFU). It returns the pinned fingerprint. If the
// user's published key differs from one previously pinned, it fails with a
// key-changed error and adds nobody. role is "member" unless "admin" is given.
func (a *App) SharingAddMember(audienceID, userID, role string) (string, error) {
	if a.neonSync == nil {
		return "", errors.New("sharing unavailable")
	}
	role = strings.TrimSpace(role)
	if role != "admin" {
		role = "member"
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	a.publishSelfName(ctx)
	fp, err := a.neonSync.AddMemberTOFU(ctx, strings.TrimSpace(audienceID), strings.TrimSpace(userID), role, true)
	if err != nil {
		return "", err
	}
	a.syncSoon()
	return fp, nil
}

// SharingInviteByEmail adds a person to a team by email. It finds their
// published identity by an email discovery hash (the server never stores the
// address), TOFU-pins their key, and adds them. Returns the added user's id.
// A "no user found" error means they aren't on Tokify — the caller can offer a
// capability link instead; a key-changed error means their key no longer matches
// a prior pin and nobody was added.
func (a *App) SharingInviteByEmail(audienceID, email, role string) (string, error) {
	if a.neonSync == nil {
		return "", errors.New("sharing unavailable")
	}
	role = strings.TrimSpace(role)
	if role != "admin" {
		role = "member"
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	a.publishSelfName(ctx)
	userID, err := a.neonSync.InviteByEmail(ctx, strings.TrimSpace(audienceID), strings.TrimSpace(email), role, true)
	if err != nil {
		return "", err
	}
	a.syncSoon()
	return userID, nil
}

// SharingRemoveMember removes a user from a team. This mints a fresh epoch so
// the removed member goes dark to future entries; a sync is kicked to reconcile
// the crypto-plane grant cleanup.
func (a *App) SharingRemoveMember(audienceID, userID string) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	if err := a.neonSync.RemoveMember(ctx, strings.TrimSpace(audienceID), strings.TrimSpace(userID)); err != nil {
		return err
	}
	a.syncSoon()
	return nil
}

// SharingTeamShare returns what a team currently sees: its shared projects and
// the history window (sinceDays; 0 means all history of those projects).
func (a *App) SharingTeamShare(audienceID string) (neonsync.ShareView, error) {
	if a.neonSync == nil {
		return neonsync.ShareView{}, errors.New("sharing unavailable")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.neonSync.TeamShare(ctx, strings.TrimSpace(audienceID))
}

// SharingSetTeamShare sets which projects a team can see and how far back
// (sinceDays: 0 shares the full history of those projects, 7/30/... limits it to
// a trailing window). Passing an empty project list clears what the team sees.
// A sync is kicked afterward so the shared slice reconciles (grants are created
// in SyncNow, not by writing the share).
func (a *App) SharingSetTeamShare(audienceID string, projects []string, sinceDays int) error {
	if a.neonSync == nil {
		return errors.New("sharing unavailable")
	}
	if sinceDays < 0 {
		return errors.New("since days must be non-negative")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	if err := a.neonSync.SetShareFilter(ctx, strings.TrimSpace(audienceID), projects, sinceDays); err != nil {
		return err
	}
	a.syncSoon()
	return nil
}

// SharedActivity is one read-only activity another member shared with a team the
// caller belongs to, decrypted and author-verified by the sharing service. It is
// display-only and never merges into the local ~/.tock.txt log. AuthorName and
// AuthorID drive the author badge in the merged Activity view; TeamName is the
// caller's local name for the audience the entry came through.
//
// Activity is a NAMED field, not embedded: models.Activity has a custom
// MarshalJSON, and embedding it would promote that method so json.Marshal emitted
// only the activity fields and silently dropped author_id/team_name/author_name.
type SharedActivity struct {
	Activity   models.Activity `json:"activity"`
	AudienceID string          `json:"audience_id"`
	TeamName   string          `json:"team_name"`
	AuthorID   string          `json:"author_id"`
	AuthorName string          `json:"author_name"`
}

// SharingSharedEntries returns every activity shared with the caller across all
// their teams, decrypted and author-verified. The result is read-only: the UI
// folds it into the Activity view tagged by author but must never write it to the
// local log. An unpinned author is a hard failure surfaced here rather than shown
// as untrusted data.
func (a *App) SharingSharedEntries() ([]SharedActivity, error) {
	if a.neonSync == nil {
		return nil, errors.New("sharing unavailable")
	}
	// Signed out means there's nothing to show — don't serve the cached rows of a
	// previous session, which would leak another member's data past sign-out. The
	// check is a local session-file read, not a network call.
	if a.neonAuth == nil || !a.neonAuth.Status().SignedIn {
		return []SharedActivity{}, nil
	}
	// Serve the cache instantly and reconcile in the background: the poll returns
	// the last-good rows without waiting on the network walk, and the refresh
	// pushes any change via the shared:updated event. Only a truly cold cache (no
	// prior session, no disk file) falls through to a synchronous fetch so the
	// merged view isn't left empty on a brand-new install.
	if a.sharedCache != nil && a.sharedCache.warm() {
		a.refreshSharedAsync()
		return a.sharedCache.get(), nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	out, err := a.fetchSharedEntries(ctx)
	if err != nil {
		return nil, err
	}
	if a.sharedCache != nil {
		a.sharedCache.set(out)
	}
	return out, nil
}

// fetchSharedEntries runs the full shared read path: list decrypted entries,
// resolve author display names, and tag each with the caller's local team name.
// This is the expensive network + crypto walk that the cache exists to hide.
func (a *App) fetchSharedEntries(ctx context.Context) ([]SharedActivity, error) {
	entries, err := a.neonSync.ListSharedEntries(ctx)
	if err != nil {
		return nil, err
	}
	authorIDs := make([]string, 0, len(entries))
	for _, e := range entries {
		authorIDs = append(authorIDs, e.AuthorID)
	}
	names, _ := a.neonSync.ResolveDisplayNames(ctx, authorIDs)
	out := make([]SharedActivity, 0, len(entries))
	for _, e := range entries {
		teamName := ""
		if a.teamNames != nil {
			teamName = a.teamNames.Name(e.AudienceID)
		}
		out = append(out, SharedActivity{
			Activity:   e.Activity,
			AudienceID: e.AudienceID,
			TeamName:   teamName,
			AuthorID:   e.AuthorID,
			AuthorName: names[e.AuthorID],
		})
	}
	return out, nil
}

// refreshSharedAsync reconciles the cache with the network in the background,
// single-flighted so a burst of polls collapses into one walk. On a real change
// it persists the snapshot and emits shared:updated so the UI updates without
// waiting for its next poll; a transient failure keeps the last-good rows.
func (a *App) refreshSharedAsync() {
	if a.neonSync == nil || a.sharedCache == nil {
		return
	}
	if !a.sharedRefreshing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer a.sharedRefreshing.Store(false)
		ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
		defer cancel()
		out, err := a.fetchSharedEntries(ctx)
		if err != nil {
			return
		}
		if a.sharedCache.set(out) {
			wailsruntime.EventsEmit(a.ctx, "shared:updated", out)
		}
	}()
}
