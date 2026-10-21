package sketchpad_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/kriuchkov/tock/internal/app/sketchpad"
)

// The phone's port (mobile/src/sync/sketchpad-merge.ts) checks itself against
// the same vectors.
func TestMergeVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/merge-vectors.json")
	require.NoError(t, err)
	var vectors []struct {
		Name   string `json:"name"`
		Base   string `json:"base"`
		Ours   string `json:"ours"`
		Theirs string `json:"theirs"`
		Want   string `json:"want"`
	}
	require.NoError(t, json.Unmarshal(data, &vectors))
	require.NotEmpty(t, vectors)
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			assert.Equal(t, v.Want, sketchpad.Merge(v.Base, v.Ours, v.Theirs))
		})
	}
}

func TestMergeKeepsUntouchedDocuments(t *testing.T) {
	docs := []string{
		"",
		"plain legacy text",
		`<p>One <strong>two</strong> <a href="https://x.test/?a=1&amp;b=&quot;&gt;">three</a></p><hr><p>Four<br>five</p>`,
		`<ul><li><p>Bullet</p><ul><li><p>Nested</p></li></ul><p>After</p></li><li><p>Next</p></li></ul>`,
		`<blockquote><p>Quote</p></blockquote><pre><code>code &lt;p&gt;</code></pre><h3>Title</h3>`,
		`<ul data-type="taskList"><li data-checked="true" data-type="taskItem" data-todo-id="x"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li></ul>`,
	}
	for _, doc := range docs {
		edited := doc + "<p>tail</p>"
		assert.Equal(t, edited, sketchpad.Merge(doc, edited, doc), doc)
		assert.Equal(t, edited, sketchpad.Merge(doc, doc, edited), doc)
		// An edit at the other end on each side still reproduces the document.
		lead := "<p>lead</p>" + doc
		assert.Equal(t, "<p>lead</p>"+edited, sketchpad.Merge(doc, lead, edited), doc)
	}
}
