// Package sketchpad keeps the sketchpad (the Notes page) on this device and in
// step with the account's other devices through neonsync's sketchpad record.
//
// The pad and the last version this device agreed with are persisted together,
// so edits made offline or before a restart are still recognised as local. A
// sync that finds both sides moved merges them (see Merge) and writes the
// result back.
package sketchpad

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/integrations/neonsync"
)

// Remote is the account's sketchpad record. Satisfied by *neonsync.Service.
type Remote interface {
	Sketchpad(ctx context.Context) (neonsync.SketchpadState, error)
	PutSketchpad(ctx context.Context, seen int64, html string) (neonsync.SketchpadState, error)
}

type Pad struct {
	remote Remote
	path   string
	syncMu sync.Mutex

	mu    sync.Mutex
	state stored
}

// stored is the pad file: this device's text and the record it last agreed
// with. Saved is false until the window first loads the pad; syncs wait for
// that, so the copy the window used to keep is imported before anything else.
type stored struct {
	HTML    string `json:"html"`
	Saved   bool   `json:"saved"`
	Owner   string `json:"owner,omitempty"`
	Version int64  `json:"version,omitempty"`
	Agreed  string `json:"agreed,omitempty"`
}

// Open loads the pad at path; a missing file is an empty pad.
func Open(remote Remote, path string) (*Pad, error) {
	p := &Pad{remote: remote, path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return nil, errors.Wrap(err, "read sketchpad")
	}
	if err = json.Unmarshal(data, &p.state); err != nil {
		return nil, errors.Wrap(err, "decode sketchpad")
	}
	return p, nil
}

// Load returns the pad, first folding in legacy: the copy the window kept in
// local storage before the pad moved here. The window clears that copy once
// loaded, so it arrives only once, and joining it with the pad loses neither.
func (p *Pad) Load(legacy string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if legacy != "" || !p.state.Saved {
		p.state.HTML = Merge("", p.state.HTML, legacy)
		if err := p.persist(); err != nil {
			return "", err
		}
	}
	return p.state.HTML, nil
}

// Text returns the pad as it stands.
func (p *Pad) Text() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state.HTML
}

// Save records an edit the editor made starting from base. If the pad moved on
// since (a sync brought in another device's edits), the two are merged; the
// result is returned either way.
func (p *Pad) Save(base, html string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state.HTML != base {
		html = Merge(base, html, p.state.HTML)
	}
	p.state.HTML = html
	return html, p.persist()
}

// Sync reconciles the pad with the account's record and reports whether that
// changed the pad here. A sync already in flight makes this a no-op.
func (p *Pad) Sync(ctx context.Context) (bool, error) {
	if !p.syncMu.TryLock() {
		return false, nil
	}
	defer p.syncMu.Unlock()

	p.mu.Lock()
	snap := p.state
	p.mu.Unlock()
	if !snap.Saved || p.remote == nil {
		return false, nil
	}

	remote, err := p.remote.Sketchpad(ctx)
	if err != nil {
		return false, err
	}
	next := snap.HTML
	for range 3 {
		agreed := snap.Agreed
		// A record behind the one agreed with, or another account's, shares no
		// history with this pad: merge as if from empty so neither side is lost.
		if remote.Owner != snap.Owner || remote.Version < snap.Version {
			agreed = ""
		}
		if remote.Version == snap.Version && remote.Owner == snap.Owner && snap.HTML == snap.Agreed {
			return false, nil
		}
		next = Merge(agreed, snap.HTML, remote.HTML)
		if next == remote.HTML && remote.Version > 0 {
			break
		}
		written, perr := p.remote.PutSketchpad(ctx, remote.Version, next)
		if errors.Is(perr, neonsync.ErrSketchpadConflict) {
			remote = written
			continue
		}
		if perr != nil {
			return false, perr
		}
		remote = written
		break
	}
	if remote.HTML != next {
		// Lost the race three times; the next sync tries again.
		return false, nil
	}
	return p.adopt(snap.HTML, remote)
}

// adopt records remote as agreed and makes it the pad, merged with any edit
// saved while the sync was on the network.
func (p *Pad) adopt(synced string, remote neonsync.SketchpadState) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	before := p.state.HTML
	p.state.HTML = Merge(synced, before, remote.HTML)
	p.state.Owner, p.state.Version, p.state.Agreed = remote.Owner, remote.Version, remote.HTML
	return p.state.HTML != before, p.persist()
}

func (p *Pad) persist() error {
	p.state.Saved = true
	data, err := json.Marshal(p.state)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return errors.Wrap(err, "create sketchpad dir")
	}
	tmp := p.path + ".tmp"
	if err = os.WriteFile(tmp, data, 0o600); err != nil {
		return errors.Wrap(err, "write sketchpad")
	}
	if err = os.Rename(tmp, p.path); err != nil {
		return errors.Wrap(err, "replace sketchpad")
	}
	return nil
}
