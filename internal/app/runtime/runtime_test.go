package runtime

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveDatabasePathUsesDefault(t *testing.T) {
	home, err := os.UserHomeDir()
	require.NoError(t, err)

	got, err := resolveDatabasePath("")
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(home, ".tock.db"), got)
}

func TestResolveDatabasePathExpandsTilde(t *testing.T) {
	home, err := os.UserHomeDir()
	require.NoError(t, err)

	got, err := resolveDatabasePath("~/.local/share/tokify.db")
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(home, ".local/share/tokify.db"), got)
}

func TestDefaultExportDir(t *testing.T) {
	rt := &Runtime{DataPath: "/tmp/tokify/activity.db"}

	got, err := rt.DefaultExportDir()
	require.NoError(t, err)
	assert.Equal(t, "/tmp/tokify", got)
}
