package mcpserver

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSetupFor(t *testing.T) {
	t.Setenv("TOKIFY_PROFILE", "")

	setup, err := SetupFor("/Applications/Tokify.app/Contents/MacOS/tock-desktop", "mcp")
	require.NoError(t, err)
	assert.Equal(t, "claude mcp add --scope user tokify -- /Applications/Tokify.app/Contents/MacOS/tock-desktop mcp", setup.ClaudeCommand)
	assert.JSONEq(t, `{"mcpServers":{"tokify":{
		"command":"/Applications/Tokify.app/Contents/MacOS/tock-desktop","args":["mcp"]}}}`, setup.JSONConfig)
}

func TestSetupForQuotesPathAndPassesProfile(t *testing.T) {
	t.Setenv("TOKIFY_PROFILE", "alice")

	setup, err := SetupFor("/Users/me/My Apps/Tokify.app/Contents/MacOS/tock-desktop", "mcp")
	require.NoError(t, err)
	assert.Equal(t,
		"claude mcp add --scope user --env TOKIFY_PROFILE=alice tokify -- '/Users/me/My Apps/Tokify.app/Contents/MacOS/tock-desktop' mcp",
		setup.ClaudeCommand)

	var cfg struct {
		MCPServers map[string]struct {
			Env map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	require.NoError(t, json.Unmarshal([]byte(setup.JSONConfig), &cfg))
	assert.Equal(t, "alice", cfg.MCPServers["tokify"].Env["TOKIFY_PROFILE"])
}
