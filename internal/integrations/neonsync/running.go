package neonsync

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	gerrors "github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/integrations/netcheck"
)

// ErrTimerConflict means the running-timer record moved on since the caller
// read it: another device started or stopped a timer first. The caller re-reads
// and applies its change on top of the fresh state.
var ErrTimerConflict = errors.New("neonsync: running timer changed on another device")

// RunningTimer is the per-user timer every device converges on. End is nil
// while it runs; once stopped the record keeps it with End set, so a device
// still showing it as running can close its copy at the same instant and the
// two completed entries hash to the same id. Discarded marks a running timer
// that was deleted rather than stopped.
type RunningTimer struct {
	Description string     `json:"d"`
	Project     string     `json:"p"`
	Notes       string     `json:"n,omitempty"`
	Tags        []string   `json:"t,omitempty"`
	Start       time.Time  `json:"s"`
	End         *time.Time `json:"e,omitempty"`
	Discarded   bool       `json:"x,omitempty"`
	DeviceID    string     `json:"dev"`
}

// TimerState is one read of the record. Version 0 with a nil Timer means no
// device has ever written one; pass Version back as `seen` when writing.
type TimerState struct {
	Version int64
	Timer   *RunningTimer
}

type runningTimerRow struct {
	UserID     string `json:"user_id"`
	Version    int64  `json:"version"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
}

// RunningTimer reads and decrypts the caller's running-timer record.
func (s *Service) RunningTimer(ctx context.Context) (TimerState, error) {
	base, token, dek, err := s.timerAccess(ctx)
	if err != nil {
		return TimerState{}, err
	}
	return readTimer(ctx, s.http, base, token, dek)
}

// PutRunningTimer replaces the record, provided it is still at version seen.
// On ErrTimerConflict the returned state is the fresh one to retry against.
func (s *Service) PutRunningTimer(ctx context.Context, seen int64, timer RunningTimer) (TimerState, error) {
	base, token, dek, err := s.timerAccess(ctx)
	if err != nil {
		return TimerState{}, err
	}
	owner, err := ownerFromKeys(ctx, s.http, base, token)
	if err != nil {
		return TimerState{}, err
	}
	return writeTimer(ctx, s.http, base, token, dek, owner, seen, timer)
}

// DeviceID returns this install's id for RunningTimer.DeviceID, creating and
// persisting it on first use.
func (s *Service) DeviceID() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.settings.DeviceID != "" {
		return s.settings.DeviceID, nil
	}
	b, err := randomBytes(16)
	if err != nil {
		return "", err
	}
	s.settings.DeviceID = hex.EncodeToString(b)
	if err = saveSettings(s.path, s.settings); err != nil {
		s.settings.DeviceID = ""
		return "", err
	}
	return s.settings.DeviceID, nil
}

// timerAccess gathers what every running-timer call needs, failing the same
// way SyncNow does when sync is off, unconfigured, offline or locked.
func (s *Service) timerAccess(ctx context.Context) (string, string, []byte, error) {
	if !s.Status().Enabled {
		return "", "", nil, errors.New("sync is turned off")
	}
	base := s.dataURL()
	if base == "" {
		return "", "", nil, ErrNotConfigured
	}
	if !netcheck.Online(ctx, hostOf(base)) {
		return "", "", nil, netcheck.ErrOffline
	}
	dek, err := s.loadDEK(ctx)
	if err != nil {
		return "", "", nil, ErrLocked
	}
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return "", "", nil, gerrors.Wrap(err, "auth token")
	}
	return base, token, dek, nil
}

func readTimer(ctx context.Context, hc *http.Client, base, token string, dek []byte) (TimerState, error) {
	data, err := doJSON(ctx, hc, http.MethodGet, endpoint(base, "/running_timers?select=*"), token, nil, "")
	if err != nil {
		return TimerState{}, gerrors.Wrap(err, "read running timer")
	}
	var rows []runningTimerRow
	if uerr := json.Unmarshal(data, &rows); uerr != nil {
		return TimerState{}, gerrors.Wrap(uerr, "decode running timer")
	}
	if len(rows) == 0 {
		return TimerState{}, nil
	}
	return openTimer(dek, rows[0])
}

// writeTimer inserts the first record or compare-and-swaps an existing one.
// Losing either race (a duplicate insert, or a PATCH matching no row) is a
// conflict, answered with a fresh read.
func writeTimer(
	ctx context.Context,
	hc *http.Client,
	base, token string,
	dek []byte,
	owner string,
	seen int64,
	timer RunningTimer,
) (TimerState, error) {
	row, err := sealTimer(dek, owner, seen+1, timer)
	if err != nil {
		return TimerState{}, err
	}
	body, err := json.Marshal(row)
	if err != nil {
		return TimerState{}, err
	}

	if seen == 0 {
		_, err = doJSON(ctx, hc, http.MethodPost, endpoint(base, "/running_timers"), token, body, "return=minimal")
		if isUniqueViolation(err) {
			return conflict(ctx, hc, base, token, dek)
		}
		if err != nil {
			return TimerState{}, gerrors.Wrap(err, "create running timer")
		}
	} else {
		path := "/running_timers?version=eq." + strconv.FormatInt(seen, 10)
		data, perr := doJSON(ctx, hc, http.MethodPatch, endpoint(base, path), token, body, "return=representation")
		if perr != nil {
			return TimerState{}, gerrors.Wrap(perr, "update running timer")
		}
		var written []runningTimerRow
		if uerr := json.Unmarshal(data, &written); uerr != nil {
			return TimerState{}, gerrors.Wrap(uerr, "decode running timer")
		}
		if len(written) == 0 {
			return conflict(ctx, hc, base, token, dek)
		}
	}
	return TimerState{Version: row.Version, Timer: &timer}, nil
}

func conflict(ctx context.Context, hc *http.Client, base, token string, dek []byte) (TimerState, error) {
	fresh, err := readTimer(ctx, hc, base, token, dek)
	if err != nil {
		return TimerState{}, err
	}
	return fresh, ErrTimerConflict
}

// timerAAD binds a ciphertext to its owner and version, so the server cannot
// present an older timer under a newer version number.
func timerAAD(owner string, version int64) []byte {
	return []byte("tokify/running-timer/v1\x00" + owner + "\x00" + strconv.FormatInt(version, 10))
}

func sealTimer(dek []byte, owner string, version int64, timer RunningTimer) (runningTimerRow, error) {
	plain, err := json.Marshal(timer)
	if err != nil {
		return runningTimerRow{}, err
	}
	ct, nonce, err := sealAAD(dek, plain, timerAAD(owner, version))
	if err != nil {
		return runningTimerRow{}, err
	}
	return runningTimerRow{UserID: owner, Version: version, Ciphertext: b64(ct), Nonce: b64(nonce)}, nil
}

func openTimer(dek []byte, row runningTimerRow) (TimerState, error) {
	ct, err := unb64(row.Ciphertext)
	if err != nil {
		return TimerState{}, err
	}
	nonce, err := unb64(row.Nonce)
	if err != nil {
		return TimerState{}, err
	}
	plain, err := openAAD(dek, ct, nonce, timerAAD(row.UserID, row.Version))
	if err != nil {
		return TimerState{}, gerrors.Wrap(err, "running timer")
	}
	var timer RunningTimer
	if uerr := json.Unmarshal(plain, &timer); uerr != nil {
		return TimerState{}, gerrors.Wrap(uerr, "decode running timer")
	}
	return TimerState{Version: row.Version, Timer: &timer}, nil
}
