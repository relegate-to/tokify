package neonsync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
	"github.com/kriuchkov/tock/internal/integrations/netcheck"
)

// ErrNotConfigured is returned when no Data API URL has been set.
var ErrNotConfigured = errors.New("neonsync: no Data API URL configured")

// ErrLocked is returned when a sync is attempted without a cached DEK — the
// user needs to sign in again so the key can be derived from their password.
var ErrLocked = errors.New("neonsync: sync is locked; sign in to unlock")

// dekAccount is the single Keychain slot for the unwrapped DEK.
const dekAccount = "dek"

// DefaultDataURL is the Neon Data API endpoint baked into release builds via
// -ldflags (see the desktop-build Makefile targets). It's empty in source so
// the package stays deployment-agnostic; local dev leaves it unset and relies
// on TOKIFY_NEON_DATA_URL or the settings file instead.
//
//nolint:gochecknoglobals // ldflags injection target; must be a package var.
var DefaultDataURL string

// syncTimeLayout matches the text log's minute-precision, local-time format
// (internal/adapters/repositories/file). Canonicalizing entry times to exactly
// what the log preserves is what keeps content-hash ids stable across a
// push -> pull -> re-read round-trip; anything finer would make the same entry
// hash differently after it passes through ~/.tock.txt.
const syncTimeLayout = "2006-01-02 15:04"

// ActivityStore is the slice of the tock activity service neonsync needs: read
// every entry, add a pulled one back, and remove one the cloud has tombstoned.
// Satisfied by ports.ActivityResolver, so the desktop app passes its runtime's
// service straight through.
type ActivityStore interface {
	List(ctx context.Context, filter models.ActivityFilter) ([]models.Activity, error)
	Add(ctx context.Context, req models.AddActivityRequest) (*models.Activity, error)
	Remove(ctx context.Context, activity models.Activity) error
}

// TokenProvider yields the current Neon Auth bearer token. Satisfied by
// neonauth.Service.Token.
type TokenProvider interface {
	Token(ctx context.Context) (string, error)
}

// Service owns encrypted sync of the activity log. Like the neonauth service it
// loads its secret (the DEK) from Keychain per call rather than caching it in
// memory, so sign-out clears it with no in-memory invalidation.
type Service struct {
	store      *keychainStore
	http       *http.Client
	activities ActivityStore
	tokens     TokenProvider

	mu         sync.RWMutex
	settings   Settings
	path       string
	tombstones *tombstoneStore
	pins       *PinStore
}

// SyncStatus is the snapshot the Account panel renders.
type SyncStatus struct {
	Configured bool   `json:"configured"`
	Enabled    bool   `json:"enabled"`
	Unlocked   bool   `json:"unlocked"`
	LastSync   string `json:"last_sync,omitempty"`
	EntryCount int    `json:"entry_count"`
	Error      string `json:"error,omitempty"`
}

func NewService(activities ActivityStore, tokens TokenProvider) (*Service, error) {
	path, err := defaultSettingsPath()
	if err != nil {
		return nil, err
	}
	s, err := loadSettings(path)
	if err != nil {
		return nil, err
	}
	// TOKIFY_NEON_DATA_URL points at a project's Data API without editing JSON —
	// handy in dev and before the settings file exists.
	if env := strings.TrimSpace(os.Getenv("TOKIFY_NEON_DATA_URL")); env != "" {
		s.DataURL = env
	} else if strings.TrimSpace(s.DataURL) == "" {
		s.DataURL = DefaultDataURL
	}
	return &Service{
		store:      newKeychainStore(),
		http:       &http.Client{Timeout: 30 * time.Second},
		activities: activities,
		tokens:     tokens,
		settings:   s,
		path:       path,
		tombstones: newTombstoneStore(path),
		pins:       newPinStore(path),
	}, nil
}

func (s *Service) dataURL() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return strings.TrimSpace(s.settings.DataURL)
}

// SetDataURL points the service at a Neon Data API project and persists it.
func (s *Service) SetDataURL(url string) error {
	s.mu.Lock()
	s.settings.DataURL = strings.TrimSpace(url)
	snapshot := s.settings
	s.mu.Unlock()
	return saveSettings(s.path, snapshot)
}

// SetEnabled flips the master switch. It does not touch the stored DEK or any
// synced rows, so sync can be turned back on without re-entering the password.
func (s *Service) SetEnabled(enabled bool) error {
	s.mu.Lock()
	s.settings.Enabled = enabled
	snapshot := s.settings
	s.mu.Unlock()
	return saveSettings(s.path, snapshot)
}

// Status reports configuration + last-sync state. Best-effort and never errors:
// the Account panel renders it on every open.
func (s *Service) Status() SyncStatus {
	s.mu.RLock()
	snapshot := s.settings
	s.mu.RUnlock()

	out := SyncStatus{
		Configured: strings.TrimSpace(snapshot.DataURL) != "",
		Enabled:    snapshot.Enabled,
		LastSync:   snapshot.LastSync,
		EntryCount: snapshot.EntryCount,
	}
	if _, err := s.loadDEK(context.Background()); err == nil {
		out.Unlocked = true
	}
	return out
}

// Unlock provisions (first sign-up) or recovers the DEK using the password, and
// caches it in Keychain. Called from the sign-in path — the one place the raw
// password exists. The password is used transiently and never stored; only the
// unwrapped DEK is cached. A wrong password surfaces as an unwrap failure.
//
// No-ops silently when sync isn't configured or the device is offline: key
// provisioning is not worth failing a sign-in over, and it will happen on the
// next sign-in once reachable.
func (s *Service) Unlock(ctx context.Context, email, password, userID, token string) error {
	base := s.dataURL()
	if base == "" || token == "" {
		return nil
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return nil
	}

	row, err := getUserKeys(ctx, s.http, base, token)
	var (
		dek []byte
		kek []byte
	)
	switch {
	case errors.Is(err, ErrNoUserKeys):
		dek, kek, err = s.provision(ctx, base, token, userID, password)
		row = nil // fresh row has no wrapped_identity yet
	case err != nil:
		return err
	default:
		dek, kek, err = unwrapFromRow(password, row)
	}
	if err != nil {
		return err
	}
	if serr := s.saveDEK(ctx, dek); serr != nil {
		return serr
	}
	// Provision (or recover) the sharing identity here — the one place the KEK
	// exists. Failure to set up sharing must not fail a sign-in that already has
	// a working DEK, so it is best-effort: sharing simply stays locked until the
	// next successful Unlock.
	if perr := s.provisionIdentity(ctx, base, token, userID, email, kek, row); perr != nil {
		return nil //nolint:nilerr // sharing setup is best-effort; DEK unlock already succeeded
	}
	return nil
}

// provision creates a fresh user_keys row: a random DEK wrapped by a KEK derived
// from the password and a fresh random salt. Only ciphertext leaves the device.
func (s *Service) provision(ctx context.Context, base, token, userID, password string) ([]byte, []byte, error) {
	salt, err := GenerateSalt()
	if err != nil {
		return nil, nil, err
	}
	dek, err := GenerateDEK()
	if err != nil {
		return nil, nil, err
	}
	kek := DeriveKEK(password, salt)
	wrapped, nonce, err := WrapDEK(dek, kek)
	if err != nil {
		return nil, nil, err
	}
	row := userKeysRow{
		UserID:     userID,
		SaltEnc:    b64(salt),
		WrappedDEK: b64(wrapped),
		WrapNonce:  b64(nonce),
	}
	if err = insertUserKeys(ctx, s.http, base, token, row); err != nil {
		return nil, nil, gerrors.Wrap(err, "provision user key")
	}
	return dek, kek, nil
}

// unwrapFromRow recovers the DEK and returns the KEK alongside it (the caller
// needs the KEK to unwrap or provision the sharing identity in the same step).
func unwrapFromRow(password string, row *userKeysRow) ([]byte, []byte, error) {
	salt, err := unb64(row.SaltEnc)
	if err != nil {
		return nil, nil, gerrors.Wrap(err, "decode salt")
	}
	wrapped, err := unb64(row.WrappedDEK)
	if err != nil {
		return nil, nil, gerrors.Wrap(err, "decode wrapped key")
	}
	nonce, err := unb64(row.WrapNonce)
	if err != nil {
		return nil, nil, gerrors.Wrap(err, "decode wrap nonce")
	}
	kek := DeriveKEK(password, salt)
	dek, err := UnwrapDEK(wrapped, nonce, kek)
	if err != nil {
		return nil, nil, errors.New("wrong password for encrypted sync")
	}
	return dek, kek, nil
}

// Lock clears the cached DEK and the cached sharing identity. Called on sign-out.
func (s *Service) Lock(ctx context.Context) error {
	s.clearIdentity(ctx)
	return s.store.Delete(ctx, dekAccount)
}

// SyncNow pushes every completed local activity as an encrypted row, then pulls
// the cloud set and merges any entries this device is missing back into the
// local log. Local ~/.tock.txt stays the source of truth; the cloud is a mirror.
func (s *Service) SyncNow(ctx context.Context) (SyncStatus, error) {
	if !s.Status().Enabled {
		return s.Status(), errors.New("sync is turned off")
	}
	base := s.dataURL()
	if base == "" {
		return s.Status(), ErrNotConfigured
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return s.Status(), netcheck.ErrOffline
	}
	dek, err := s.loadDEK(ctx)
	if err != nil {
		return s.Status(), ErrLocked
	}
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return s.Status(), gerrors.Wrap(err, "auth token")
	}

	local, err := s.activities.List(ctx, models.ActivityFilter{})
	if err != nil {
		return s.Status(), gerrors.Wrap(err, "read local activities")
	}

	// Index completed local entries by content id. Running (open) entries have no
	// final content and are never synced.
	localByID := make(map[string]models.Activity, len(local))
	for _, act := range local {
		if act.EndTime == nil {
			continue
		}
		localByID[EntryID(dek, canonicalize(act))] = act
	}

	// Reconcile local tombstones into the ids to delete cloud-side. A tombstoned
	// entry that exists locally again was recreated after deletion, so its
	// tombstone is stale and dropped.
	delIDs, err := s.pendingDeletions(dek, localByID)
	if err != nil {
		return s.Status(), err
	}

	// A sharing session exists only once the identity is provisioned+unlocked.
	// When present, push entries in their v2 form (AAD-bound, author-signed) so
	// audience members can read them, then reconcile grants after the push (the
	// grants FK requires entries to exist first). When absent, fall back to the
	// legacy account-DEK push; sharing stays dormant.
	sess, sessErr := s.session(ctx)
	if sessErr == nil {
		if err = s.pushSharedEntries(ctx, sess, localByID); err != nil {
			return s.Status(), err
		}
	} else if err = s.push(ctx, base, token, dek, localByID); err != nil {
		return s.Status(), err
	}
	if err = markDeleted(ctx, s.http, base, token, mapKeys(delIDs)); err != nil {
		return s.Status(), gerrors.Wrap(err, "propagate deletions")
	}
	if sessErr == nil {
		// Reconcile-on-write across my audiences. Per-audience failures (e.g. an
		// unverifiable epoch chain, §2b) are collected and must not abort the sync
		// of everything else; they surface via the status error line.
		if rerrs := s.reconcileAudiences(ctx, sess, localByID, time.Now()); len(rerrs) > 0 {
			err = rerrs[0]
		}
	}
	merged, perr := s.pull(ctx, base, token, dek, localByID, delIDs)
	if perr != nil {
		return s.Status(), perr
	}

	s.recordSync(merged)
	if err != nil {
		return s.Status(), err
	}
	return s.Status(), nil
}

// pendingDeletions turns the local tombstone set into the ids to mark deleted in
// the cloud. It drops (and rewrites away) any tombstone whose entry is present in
// localByID — that entry was recreated after deletion, so its deletion no longer
// stands.
func (s *Service) pendingDeletions(dek []byte, localByID map[string]models.Activity) (map[string]struct{}, error) {
	canon, err := s.tombstones.all()
	if err != nil {
		return nil, err
	}
	del := make(map[string]struct{})
	keep := make([][]byte, 0, len(canon))
	for _, c := range canon {
		id := EntryID(dek, c)
		if _, live := localByID[id]; live {
			continue // recreated after deletion; stale tombstone
		}
		del[id] = struct{}{}
		keep = append(keep, c)
	}
	if len(keep) != len(canon) {
		if rerr := s.tombstones.replace(keep); rerr != nil {
			return nil, rerr
		}
	}
	return del, nil
}

// push writes one encrypted row per completed local entry, keyed by content hash
// so the upsert dedupes. The `deleted` column is deliberately not sent (see
// entryRow) so re-pushing a live entry never clobbers a tombstone another device
// set.
func (s *Service) push(ctx context.Context, base, token string, dek []byte, localByID map[string]models.Activity) error {
	rows := make([]entryRow, 0, len(localByID))
	for id, act := range localByID {
		ct, nonce, encErr := EncryptEntry(dek, canonicalize(act))
		if encErr != nil {
			return encErr
		}
		rows = append(rows, entryRow{
			ID:         id,
			UserID:     "", // RLS/DEFAULT can't fill this; set below from token owner
			Ciphertext: b64(ct),
			Nonce:      b64(nonce),
		})
	}
	// user_id must equal the JWT owner or WITH CHECK rejects the write. Read it
	// back from the key row we already provisioned rather than trusting a
	// caller-passed id.
	owner, err := ownerFromKeys(ctx, s.http, base, token)
	if err != nil {
		return err
	}
	for i := range rows {
		rows[i].UserID = owner
	}
	if err = upsertEntries(ctx, s.http, base, token, rows); err != nil {
		return gerrors.Wrap(err, "push entries")
	}
	return nil
}

// pull reconciles the cloud set against the local log: it removes local entries
// the cloud has tombstoned (a deletion made on another device), then adds any
// live entry this device lacks. localByID (completed local entries by id) is
// mutated as rows are removed or merged. delIDs are this device's own pending
// deletions, skipped so a just-deleted entry isn't re-added from a cloud row that
// hasn't been marked deleted yet. Returns the resulting local entry count.
func (s *Service) pull(
	ctx context.Context,
	base, token string,
	dek []byte,
	localByID map[string]models.Activity,
	delIDs map[string]struct{},
) (int, error) {
	cloud, err := getEntries(ctx, s.http, base, token)
	if err != nil {
		return 0, gerrors.Wrap(err, "pull entries")
	}
	// owner is needed for the v2 (AAD-bound) decode of the caller's own rows; a
	// blank owner just means the v2 attempt fails and the legacy path is used.
	owner, _ := ownerFromKeys(ctx, s.http, base, token)

	// Remote tombstones win: drop any local entry the cloud reports deleted.
	liveInCloud := make(map[string]struct{}, len(cloud))
	for _, row := range cloud {
		if !row.Deleted {
			liveInCloud[row.ID] = struct{}{}
			continue
		}
		if act, ok := localByID[row.ID]; ok {
			if remErr := s.activities.Remove(ctx, act); remErr != nil {
				return 0, gerrors.Wrap(remErr, "apply remote deletion")
			}
			delete(localByID, row.ID)
		}
	}

	// Forget tombstones the cloud has accepted (marked deleted) or never held,
	// keeping only ids still live server-side so a failed PATCH retries next sync.
	s.pruneConfirmedTombstones(dek, liveInCloud)

	// Merge down anything the cloud has that we lack and didn't just delete.
	for _, row := range cloud {
		if row.Deleted {
			continue
		}
		if _, ok := localByID[row.ID]; ok {
			continue
		}
		if _, ok := delIDs[row.ID]; ok {
			continue // deleted on this device this cycle; don't resurrect
		}
		act, decErr := s.decodeOwnRow(dek, owner, row)
		if decErr != nil {
			// A row we can't decrypt is not fatal to the whole sync; skip it.
			continue
		}
		if _, addErr := s.activities.Add(ctx, models.AddActivityRequest{
			Description: act.Description,
			Project:     act.Project,
			StartTime:   act.StartTime,
			EndTime:     *act.EndTime,
		}); addErr != nil {
			return 0, gerrors.Wrap(addErr, "merge pulled entry")
		}
		localByID[row.ID] = act
	}
	return len(localByID), nil
}

// pruneConfirmedTombstones drops tombstones whose cloud row is no longer live —
// successfully marked deleted, or never present — keeping only ids the server
// still reports live, so a PATCH that failed is retried on the next sync.
func (s *Service) pruneConfirmedTombstones(dek []byte, liveInCloud map[string]struct{}) {
	canon, err := s.tombstones.all()
	if err != nil {
		return
	}
	keep := make([][]byte, 0, len(canon))
	for _, c := range canon {
		if _, live := liveInCloud[EntryID(dek, c)]; live {
			keep = append(keep, c)
		}
	}
	if len(keep) != len(canon) {
		_ = s.tombstones.replace(keep)
	}
}

// RecordDeletion tombstones a locally removed (or edited-away) entry so the next
// sync propagates the removal to the cloud and other devices instead of the pull
// step resurrecting it. It only touches a local file — no network, no DEK — and
// no-ops when sync was never configured. Pass the activity exactly as it existed
// before the change so its canonical id matches the row that was pushed. Running
// entries were never pushed, so they need no tombstone; a no-op edit is harmless
// because the still-present local entry drops the stale tombstone next sync.
func (s *Service) RecordDeletion(activity models.Activity) error {
	if activity.EndTime == nil {
		return nil
	}
	if s.dataURL() == "" {
		return nil
	}
	return s.tombstones.add(canonicalize(activity))
}

// mapKeys returns the keys of a set as a slice.
func mapKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func (s *Service) recordSync(count int) {
	s.mu.Lock()
	s.settings.LastSync = time.Now().UTC().Format(time.RFC3339)
	s.settings.EntryCount = count
	snapshot := s.settings
	s.mu.Unlock()
	_ = saveSettings(s.path, snapshot)
}

func (s *Service) loadDEK(ctx context.Context) ([]byte, error) {
	raw, err := s.store.Load(ctx, dekAccount)
	if err != nil {
		return nil, err
	}
	return unb64(raw)
}

func (s *Service) saveDEK(ctx context.Context, dek []byte) error {
	return s.store.Save(ctx, dekAccount, b64(dek))
}

// ownerFromKeys returns the caller's own user_id via their key row. RLS
// guarantees this is the JWT owner, so stamping entries with it satisfies
// WITH CHECK without parsing the token client-side.
func ownerFromKeys(ctx context.Context, hc *http.Client, base, token string) (string, error) {
	row, err := getUserKeys(ctx, hc, base, token)
	if err != nil {
		return "", err
	}
	return row.UserID, nil
}

// canonicalEntry is the stable, log-faithful serialization that is both the
// encryption plaintext and the content-hash preimage. It carries only what the
// text log round-trips (time at minute precision, project, description); notes
// and tags live in a separate store and are deferred to a follow-up.
type canonicalEntry struct {
	Description string `json:"d"`
	Project     string `json:"p"`
	Start       string `json:"s"`
	End         string `json:"e"`
}

func canonicalize(a models.Activity) []byte {
	end := ""
	if a.EndTime != nil {
		end = a.EndTime.Format(syncTimeLayout)
	}
	// json.Marshal of a fixed-field struct is deterministic (field order, no
	// maps), so the same entry always yields the same bytes and thus the same id.
	b, _ := json.Marshal(canonicalEntry{
		Description: a.Description,
		Project:     a.Project,
		Start:       a.StartTime.Format(syncTimeLayout),
		End:         end,
	})
	return b
}

// decodeRow decrypts a legacy entry row (account-DEK, no AAD) into an activity.
// The v2 shared read path decrypts differently (per-entry derived DEK + AAD);
// see decodeSharedRow, which falls back here for old rows.
func decodeRow(dek []byte, row entryRow) (models.Activity, error) {
	ct, err := unb64(row.Ciphertext)
	if err != nil {
		return models.Activity{}, err
	}
	nonce, err := unb64(row.Nonce)
	if err != nil {
		return models.Activity{}, err
	}
	plain, err := DecryptEntry(dek, ct, nonce)
	if err != nil {
		return models.Activity{}, err
	}
	return activityFromCanonical(plain)
}

// decodeOwnRow decrypts one of the caller's own cloud entry rows, trying the v2
// format first (per-entry derived DEK + EntryAAD bound to entry id / version 1 /
// owner) and falling back to the legacy account-DEK-no-AAD format for rows
// written by an older client (§ v2 entry push). ownerID may be empty, in which
// case only the legacy path can succeed.
func (s *Service) decodeOwnRow(dek []byte, ownerID string, row entryRow) (models.Activity, error) {
	if ownerID != "" {
		if act, err := decodeV2OwnRow(dek, ownerID, row); err == nil {
			return act, nil
		}
	}
	return decodeRow(dek, row)
}

// decodeV2OwnRow decrypts a v2-format own row: the DEK is derived from the
// account DEK and the row id, and EntryAAD binds (id, version 1, owner).
func decodeV2OwnRow(dek []byte, ownerID string, row entryRow) (models.Activity, error) {
	entryDEK, err := sharing.DeriveEntryDEK(dek, row.ID)
	if err != nil {
		return models.Activity{}, err
	}
	ct, err := unb64(row.Ciphertext)
	if err != nil {
		return models.Activity{}, err
	}
	nonce, err := unb64(row.Nonce)
	if err != nil {
		return models.Activity{}, err
	}
	plain, err := sharing.DecryptEntryPayload(entryDEK, ct, nonce, sharing.EntryAAD{
		EntryID: row.ID, Version: entryVersion, AuthorID: ownerID,
	})
	if err != nil {
		return models.Activity{}, err
	}
	return activityFromCanonical(plain)
}

// activityFromCanonical parses the log-faithful canonical bytes (the shared
// encryption plaintext and content-hash preimage) back into an Activity.
func activityFromCanonical(plain []byte) (models.Activity, error) {
	var c canonicalEntry
	if uerr := json.Unmarshal(plain, &c); uerr != nil {
		return models.Activity{}, uerr
	}
	start, err := time.ParseInLocation(syncTimeLayout, c.Start, time.Local)
	if err != nil {
		return models.Activity{}, gerrors.Wrap(err, "parse start")
	}
	if c.End == "" {
		return models.Activity{}, errors.New("pulled entry has no end time")
	}
	end, err := time.ParseInLocation(syncTimeLayout, c.End, time.Local)
	if err != nil {
		return models.Activity{}, gerrors.Wrap(err, "parse end")
	}
	return models.Activity{
		Description: c.Description,
		Project:     c.Project,
		StartTime:   start,
		EndTime:     &end,
	}, nil
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func unb64(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
