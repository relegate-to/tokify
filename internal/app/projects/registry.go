// Package projects maintains Tokify's client-side project registry.
//
// tock models a project only implicitly, as the Project string on activity
// rows in ~/.tock.txt, so a project cannot exist until time is tracked against
// it. Tokify needs projects to be first-class — you create one, assemble its
// sharing team, then start tracking — so this registry persists known projects
// as JSON under ~/Library/Application Support/Tokify, alongside neonsync.json
// and for the same reason: to keep Tokify state out of the upstream tock data
// file, which is shared verbatim with the CLI.
//
// The registry is also the only home for the project -> sharing audience
// mapping. The sharing server is deliberately blind to project names (they live
// only inside encrypted share filters), so "project Foo is audience abc123" is
// knowledge that can be held client-side without breaking the zero-knowledge
// posture — persisting it server-side would leak plaintext project names.
package projects

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-faster/errors"
)

// Project is a first-class Tokify project. Name is the exact string that appears
// as an activity's project. AudienceID, when set, binds the project to a sharing
// audience (its team); it stays client-side by design.
type Project struct {
	Name       string `json:"name"`
	AudienceID string `json:"audience_id,omitempty"`
}

// Registry is the persisted set of known projects. Safe for concurrent use.
type Registry struct {
	path  string
	mu    sync.Mutex
	items []Project
	index map[string]int // project name -> position in items
}

type registryFile struct {
	Projects []Project `json:"projects"`
}

// DefaultPath is where the registry lives, next to the other Tokify state files.
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Wrap(err, "home dir")
	}
	return filepath.Join(home, "Library", "Application Support", "Tokify", "projects.json"), nil
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
		return nil, errors.Wrap(err, "read projects")
	}
	var f registryFile
	if uerr := json.Unmarshal(data, &f); uerr != nil {
		return nil, errors.Wrap(uerr, "unmarshal projects")
	}
	for _, p := range f.Projects {
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" {
			continue
		}
		if _, ok := r.index[p.Name]; ok {
			continue
		}
		r.index[p.Name] = len(r.items)
		r.items = append(r.items, p)
	}
	return r, nil
}

// List returns the registered projects in insertion order.
func (r *Registry) List() []Project {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Project, len(r.items))
	copy(out, r.items)
	return out
}

// Ensure registers any names not already present, in the given order, and
// persists the registry if it changed. Blank names are skipped. This is how
// projects seen in the activity log become first-class without an explicit
// create.
func (r *Registry) Ensure(names ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	changed := false
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if _, ok := r.index[name]; ok {
			continue
		}
		r.index[name] = len(r.items)
		r.items = append(r.items, Project{Name: name})
		changed = true
	}
	if !changed {
		return nil
	}
	return r.save()
}

// Create registers a project explicitly and returns it. It is idempotent: an
// existing project of the same name is returned unchanged. This is what lets a
// project exist before any time is tracked against it.
func (r *Registry) Create(name string) (Project, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Project{}, errors.New("project name is empty")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if i, ok := r.index[name]; ok {
		return r.items[i], nil
	}
	p := Project{Name: name}
	r.index[name] = len(r.items)
	r.items = append(r.items, p)
	if err := r.save(); err != nil {
		return Project{}, err
	}
	return p, nil
}

// save writes the registry to disk. Callers hold r.mu.
func (r *Registry) save() error {
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return errors.Wrap(err, "ensure projects dir")
	}
	data, err := json.MarshalIndent(registryFile{Projects: r.items}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "marshal projects")
	}
	if werr := os.WriteFile(r.path, data, 0o600); werr != nil {
		return errors.Wrap(werr, "write projects")
	}
	return nil
}
