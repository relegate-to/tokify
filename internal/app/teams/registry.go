// Package teams maintains Tokify's client-side team-name registry.
//
// A sharing "team" is an audience (internal/integrations/neonsync): the server
// identifies it only by an opaque id and is deliberately blind to any human
// name. A team name is therefore client-side metadata, persisted here as JSON
// under ~/Library/Application Support/Tokify alongside projects.json and
// neonsync.json, for the same reason: to keep Tokify state out of the upstream
// tock data file and off the zero-knowledge server.
package teams

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-faster/errors"

	"github.com/kriuchkov/tock/internal/appdir"
)

// Team is a local name for a sharing audience. AudienceID is the neonsync
// audience id; Name is what the user calls it on this device.
type Team struct {
	AudienceID string `json:"audience_id"`
	Name       string `json:"name"`
}

// Registry is the persisted set of team names. Safe for concurrent use.
type Registry struct {
	path  string
	mu    sync.Mutex
	items []Team
	index map[string]int // audience id -> position in items
}

type registryFile struct {
	Teams []Team `json:"teams"`
}

// DefaultPath is where the registry lives, next to the other Tokify state files.
func DefaultPath() (string, error) {
	return appdir.Path("teams.json")
}

// Open loads the registry at path, returning an empty registry if the file does
// not exist yet.
func Open(path string) (*Registry, error) {
	r := &Registry{path: path, index: map[string]int{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return r, nil
		}
		return nil, errors.Wrap(err, "read teams")
	}
	var f registryFile
	if uerr := json.Unmarshal(data, &f); uerr != nil {
		return nil, errors.Wrap(uerr, "unmarshal teams")
	}
	for _, t := range f.Teams {
		t.AudienceID = strings.TrimSpace(t.AudienceID)
		t.Name = strings.TrimSpace(t.Name)
		if t.AudienceID == "" {
			continue
		}
		if _, ok := r.index[t.AudienceID]; ok {
			continue
		}
		r.index[t.AudienceID] = len(r.items)
		r.items = append(r.items, t)
	}
	return r, nil
}

// List returns the named teams in insertion order.
func (r *Registry) List() []Team {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Team, len(r.items))
	copy(out, r.items)
	return out
}

// Name returns the local name for an audience, or "" if it has none.
func (r *Registry) Name(audienceID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if i, ok := r.index[strings.TrimSpace(audienceID)]; ok {
		return r.items[i].Name
	}
	return ""
}

// SetName records or updates the local name for an audience and persists it.
func (r *Registry) SetName(audienceID, name string) (Team, error) {
	audienceID = strings.TrimSpace(audienceID)
	name = strings.TrimSpace(name)
	if audienceID == "" {
		return Team{}, errors.New("audience id is empty")
	}
	if name == "" {
		return Team{}, errors.New("team name is empty")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if i, ok := r.index[audienceID]; ok {
		r.items[i].Name = name
		if err := r.save(); err != nil {
			return Team{}, err
		}
		return r.items[i], nil
	}
	t := Team{AudienceID: audienceID, Name: name}
	r.index[audienceID] = len(r.items)
	r.items = append(r.items, t)
	if err := r.save(); err != nil {
		return Team{}, err
	}
	return t, nil
}

// Remove drops the local name for an audience (e.g. after leaving or deleting a
// team). No-op if the audience is unknown.
func (r *Registry) Remove(audienceID string) error {
	audienceID = strings.TrimSpace(audienceID)
	r.mu.Lock()
	defer r.mu.Unlock()
	i, ok := r.index[audienceID]
	if !ok {
		return nil
	}
	r.items = append(r.items[:i], r.items[i+1:]...)
	delete(r.index, audienceID)
	for j := i; j < len(r.items); j++ {
		r.index[r.items[j].AudienceID] = j
	}
	return r.save()
}

// save writes the registry to disk. Callers hold r.mu.
func (r *Registry) save() error {
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return errors.Wrap(err, "ensure teams dir")
	}
	data, err := json.MarshalIndent(registryFile{Teams: r.items}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "marshal teams")
	}
	if werr := os.WriteFile(r.path, data, 0o600); werr != nil {
		return errors.Wrap(werr, "write teams")
	}
	return nil
}
