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
// on TOKI_NEON_DATA_URL or the settings file instead.
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
// every entry, and add a pulled one back. Satisfied by ports.ActivityResolver,
// so the desktop app passes its runtime's service straight through.
type ActivityStore interface {
	List(ctx context.Context, filter models.ActivityFilter) ([]models.Activity, error)
	Add(ctx context.Context, req models.AddActivityRequest) (*models.Activity, error)
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

	mu       sync.RWMutex
	settings Settings
	path     string
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
	// TOKI_NEON_DATA_URL points at a project's Data API without editing JSON —
	// handy in dev and before the settings file exists.
	if env := strings.TrimSpace(os.Getenv("TOKI_NEON_DATA_URL")); env != "" {
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
func (s *Service) Unlock(ctx context.Context, _, password, userID, token string) error {
	base := s.dataURL()
	if base == "" || token == "" {
		return nil
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return nil
	}

	row, err := getUserKeys(ctx, s.http, base, token)
	var dek []byte
	switch {
	case errors.Is(err, ErrNoUserKeys):
		dek, err = s.provision(ctx, base, token, userID, password)
	case err != nil:
		return err
	default:
		dek, err = unwrapFromRow(password, row)
	}
	if err != nil {
		return err
	}
	return s.saveDEK(ctx, dek)
}

// provision creates a fresh user_keys row: a random DEK wrapped by a KEK derived
// from the password and a fresh random salt. Only ciphertext leaves the device.
func (s *Service) provision(ctx context.Context, base, token, userID, password string) ([]byte, error) {
	salt, err := GenerateSalt()
	if err != nil {
		return nil, err
	}
	dek, err := GenerateDEK()
	if err != nil {
		return nil, err
	}
	kek := DeriveKEK(password, salt)
	wrapped, nonce, err := WrapDEK(dek, kek)
	if err != nil {
		return nil, err
	}
	row := userKeysRow{
		UserID:     userID,
		SaltEnc:    b64(salt),
		WrappedDEK: b64(wrapped),
		WrapNonce:  b64(nonce),
	}
	if err = insertUserKeys(ctx, s.http, base, token, row); err != nil {
		return nil, gerrors.Wrap(err, "provision user key")
	}
	return dek, nil
}

func unwrapFromRow(password string, row *userKeysRow) ([]byte, error) {
	salt, err := unb64(row.SaltEnc)
	if err != nil {
		return nil, gerrors.Wrap(err, "decode salt")
	}
	wrapped, err := unb64(row.WrappedDEK)
	if err != nil {
		return nil, gerrors.Wrap(err, "decode wrapped key")
	}
	nonce, err := unb64(row.WrapNonce)
	if err != nil {
		return nil, gerrors.Wrap(err, "decode wrap nonce")
	}
	kek := DeriveKEK(password, salt)
	dek, err := UnwrapDEK(wrapped, nonce, kek)
	if err != nil {
		return nil, errors.New("wrong password for encrypted sync")
	}
	return dek, nil
}

// Lock clears the cached DEK. Called on sign-out.
func (s *Service) Lock(ctx context.Context) error {
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

	haveLocal, err := s.push(ctx, base, token, dek, local)
	if err != nil {
		return s.Status(), err
	}
	merged, err := s.pull(ctx, base, token, dek, haveLocal)
	if err != nil {
		return s.Status(), err
	}

	s.recordSync(merged)
	return s.Status(), nil
}

// push writes one encrypted row per completed local entry, keyed by content hash
// so the upsert dedupes. Running (open) entries are skipped — they have no end
// and their content isn't final. Returns the set of ids known locally so the
// pull step can tell which cloud rows are missing.
func (s *Service) push(ctx context.Context, base, token string, dek []byte, local []models.Activity) (map[string]struct{}, error) {
	haveLocal := make(map[string]struct{}, len(local))
	rows := make([]entryRow, 0, len(local))
	for _, act := range local {
		if act.EndTime == nil {
			continue
		}
		canonical := canonicalize(act)
		id := EntryID(dek, canonical)
		haveLocal[id] = struct{}{}
		ct, nonce, encErr := EncryptEntry(dek, canonical)
		if encErr != nil {
			return nil, encErr
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
		return nil, err
	}
	for i := range rows {
		rows[i].UserID = owner
	}
	if err = upsertEntries(ctx, s.http, base, token, rows); err != nil {
		return nil, gerrors.Wrap(err, "push entries")
	}
	return haveLocal, nil
}

// pull decrypts the cloud set and adds any entry this device lacks back into the
// local log, returning the merged entry count. haveLocal is mutated as rows are
// merged so a duplicate cloud row is only added once.
func (s *Service) pull(ctx context.Context, base, token string, dek []byte, haveLocal map[string]struct{}) (int, error) {
	cloud, err := getEntries(ctx, s.http, base, token)
	if err != nil {
		return 0, gerrors.Wrap(err, "pull entries")
	}
	merged := len(haveLocal)
	for _, row := range cloud {
		if row.Deleted {
			continue
		}
		if _, ok := haveLocal[row.ID]; ok {
			continue
		}
		act, decErr := decodeRow(dek, row)
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
		haveLocal[row.ID] = struct{}{}
		merged++
	}
	return merged, nil
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
