package sketchpad_test

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/kriuchkov/tock/internal/app/sketchpad"
	"github.com/kriuchkov/tock/internal/integrations/neonsync"
)

// fakeRemote is the account's record, shared by the pads standing in for
// devices. beforePut runs ahead of a write, to let another device race it.
type fakeRemote struct {
	mu        sync.Mutex
	owner     string
	state     neonsync.SketchpadState
	beforePut func()
}

func (f *fakeRemote) Sketchpad(context.Context) (neonsync.SketchpadState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state, nil
}

func (f *fakeRemote) PutSketchpad(_ context.Context, seen int64, html string) (neonsync.SketchpadState, error) {
	if hook := f.beforePut; hook != nil {
		f.beforePut = nil
		hook()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if seen != f.state.Version {
		return f.state, neonsync.ErrSketchpadConflict
	}
	f.state = neonsync.SketchpadState{Version: seen + 1, Owner: f.owner, HTML: html}
	return f.state, nil
}

func device(t *testing.T, remote sketchpad.Remote, legacy string) *sketchpad.Pad {
	t.Helper()
	pad, err := sketchpad.Open(remote, filepath.Join(t.TempDir(), "sketchpad.json"))
	require.NoError(t, err)
	_, err = pad.Load(legacy)
	require.NoError(t, err)
	return pad
}

func text(_ *testing.T, pad *sketchpad.Pad) string {
	return pad.Text()
}

func TestEditsReachTheOtherDevice(t *testing.T) {
	ctx := t.Context()
	remote := &fakeRemote{owner: "alice"}
	mac := device(t, remote, "<p>From the old window</p>")
	phone := device(t, remote, "")

	_, err := mac.Sync(ctx)
	require.NoError(t, err)
	changed, err := phone.Sync(ctx)
	require.NoError(t, err)
	assert.True(t, changed)
	assert.Equal(t, "<p>From the old window</p>", text(t, phone))

	_, err = phone.Save("<p>From the old window</p>", "<p>From the old window</p><p>Phone</p>")
	require.NoError(t, err)
	_, err = mac.Save("<p>From the old window</p>", "<p>Mac</p><p>From the old window</p>")
	require.NoError(t, err)
	_, err = phone.Sync(ctx)
	require.NoError(t, err)
	_, err = mac.Sync(ctx)
	require.NoError(t, err)
	_, err = phone.Sync(ctx)
	require.NoError(t, err)

	want := "<p>Mac</p><p>From the old window</p><p>Phone</p>"
	assert.Equal(t, want, text(t, mac))
	assert.Equal(t, want, text(t, phone))
	assert.Equal(t, want, remote.state.HTML)

	changed, err = mac.Sync(ctx)
	require.NoError(t, err)
	assert.False(t, changed)
	assert.Equal(t, int64(3), remote.state.Version, "a settled pad writes nothing")
}

func TestSaveMergesWithASyncedChange(t *testing.T) {
	ctx := t.Context()
	remote := &fakeRemote{owner: "alice", state: neonsync.SketchpadState{Version: 1, Owner: "alice", HTML: "<p>A</p><p>B</p>"}}
	mac := device(t, remote, "")
	_, err := mac.Sync(ctx)
	require.NoError(t, err)

	remote.state = neonsync.SketchpadState{Version: 2, Owner: "alice", HTML: "<p>A from phone</p><p>B</p>"}
	_, err = mac.Sync(ctx)
	require.NoError(t, err)

	// The window typed into B before it saw the phone's edit.
	got, err := mac.Save("<p>A</p><p>B</p>", "<p>A</p><p>B typed</p>")
	require.NoError(t, err)
	assert.Equal(t, "<p>A from phone</p><p>B typed</p>", got)
}

func TestSyncSurvivesARaceAndAnEditMidSync(t *testing.T) {
	ctx := t.Context()
	remote := &fakeRemote{owner: "alice", state: neonsync.SketchpadState{Version: 1, Owner: "alice", HTML: "<p>A</p>"}}
	mac := device(t, remote, "")
	_, err := mac.Sync(ctx)
	require.NoError(t, err)
	_, err = mac.Save("<p>A</p>", "<p>A</p><p>Mac</p>")
	require.NoError(t, err)

	remote.beforePut = func() {
		remote.state = neonsync.SketchpadState{Version: 2, Owner: "alice", HTML: "<p>Phone</p><p>A</p>"}
		_, serr := mac.Save("<p>A</p><p>Mac</p>", "<p>A</p><p>Mac</p><p>Typing</p>")
		require.NoError(t, serr)
	}
	_, err = mac.Sync(ctx)
	require.NoError(t, err)
	assert.Equal(t, "<p>Phone</p><p>A</p><p>Mac</p>", remote.state.HTML)
	assert.Equal(t, "<p>Phone</p><p>A</p><p>Mac</p><p>Typing</p>", text(t, mac))

	_, err = mac.Sync(ctx)
	require.NoError(t, err)
	assert.Equal(t, "<p>Phone</p><p>A</p><p>Mac</p><p>Typing</p>", remote.state.HTML)
}

func TestAnotherAccountKeepsBothPads(t *testing.T) {
	ctx := t.Context()
	first := &fakeRemote{owner: "alice"}
	path := filepath.Join(t.TempDir(), "sketchpad.json")
	pad, err := sketchpad.Open(first, path)
	require.NoError(t, err)
	_, err = pad.Load("<p>Alice</p>")
	require.NoError(t, err)
	_, err = pad.Sync(ctx)
	require.NoError(t, err)

	// Signed in as someone else, whose record is empty or at an older version.
	second := &fakeRemote{owner: "bob", state: neonsync.SketchpadState{Version: 1, Owner: "bob", HTML: "<p>Bob</p>"}}
	pad, err = sketchpad.Open(second, path)
	require.NoError(t, err)
	_, err = pad.Sync(ctx)
	require.NoError(t, err)
	assert.Equal(t, "<p>Alice</p><p>Bob</p>", text(t, pad))

	third := &fakeRemote{owner: "carol"}
	pad, err = sketchpad.Open(third, path)
	require.NoError(t, err)
	_, err = pad.Sync(ctx)
	require.NoError(t, err)
	assert.Equal(t, "<p>Alice</p><p>Bob</p>", third.state.HTML)
}

func TestSyncWaitsForTheFirstLoad(t *testing.T) {
	remote := &fakeRemote{owner: "alice", state: neonsync.SketchpadState{Version: 1, Owner: "alice", HTML: "<p>Remote</p>"}}
	pad, err := sketchpad.Open(remote, filepath.Join(t.TempDir(), "sketchpad.json"))
	require.NoError(t, err)
	changed, err := pad.Sync(t.Context())
	require.NoError(t, err)
	assert.False(t, changed)

	html, err := pad.Load("<p>Legacy</p>")
	require.NoError(t, err)
	assert.Equal(t, "<p>Legacy</p>", html)
	_, err = pad.Sync(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "<p>Legacy</p><p>Remote</p>", text(t, pad))
}

func TestLegacyJoinsAPadAlreadyLoaded(t *testing.T) {
	pad := device(t, &fakeRemote{owner: "alice"}, "")
	_, err := pad.Save("", "<p>Typed</p>")
	require.NoError(t, err)
	html, err := pad.Load("<p>Legacy</p>")
	require.NoError(t, err)
	assert.Equal(t, "<p>Typed</p><p>Legacy</p>", html)
	html, err = pad.Load("<p>Typed</p><p>Legacy</p>")
	require.NoError(t, err)
	assert.Equal(t, "<p>Typed</p><p>Legacy</p>", html, "the same copy again adds nothing")
}
