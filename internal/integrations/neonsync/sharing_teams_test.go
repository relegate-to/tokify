package neonsync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEmailHashNormalizesAndEncodes(t *testing.T) {
	if got := emailHash(""); got != "" {
		t.Fatalf("empty email should hash to empty, got %q", got)
	}
	if got := emailHash("   "); got != "" {
		t.Fatalf("blank email should hash to empty, got %q", got)
	}

	// Case and surrounding whitespace must not change the handle, or an inviter
	// and the publisher would derive different hashes and never match.
	if emailHash("Alex@Example.com") != emailHash("  alex@example.com ") {
		t.Fatal("email hash must be case- and whitespace-insensitive")
	}

	// Pin the wire contract: normalize (lower+trim) then hex(sha256).
	sum := sha256.Sum256([]byte("alex@example.com"))
	if got, want := emailHash("Alex@Example.com "), hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("email hash encoding changed: got %q want %q", got, want)
	}

	if emailHash("a@b.com") == emailHash("c@d.com") {
		t.Fatal("distinct emails must hash differently")
	}
}

// A deployment that has not applied the image_url migration answers the profile
// upsert with PGRST204. The display name rides in the same row, so dropping the
// write outright is what empties a team roster of its names — the avatar must be
// the only thing lost.
func TestUpsertIdentityFallsBackWhenImageColumnMissing(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var row map[string]any
		if err := json.Unmarshal(raw, &row); err != nil {
			t.Errorf("decode body: %v", err)
		}
		bodies = append(bodies, row)
		if _, ok := row["image_url"]; ok {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write(
				[]byte(`{"code":"PGRST204","message":"Could not find the 'image_url' column of 'identities' in the schema cache"}`),
			)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	image := "data:image/png;base64,AAAA"
	row := identityRow{UserID: "u1", PubEnc: "enc", PubSig: "sig", DisplayName: "Ada", ImageURL: &image}
	if err := upsertIdentity(context.Background(), srv.Client(), srv.URL, "tok", row); err != nil {
		t.Fatalf("upsert should degrade to a name-only publish, got %v", err)
	}
	if len(bodies) != 2 {
		t.Fatalf("expected an avatar attempt then a name-only retry, got %d writes", len(bodies))
	}
	if _, ok := bodies[1]["image_url"]; ok {
		t.Fatal("retry must omit image_url entirely, not send it empty")
	}
	if bodies[1]["display_name"] != "Ada" {
		t.Fatalf("retry lost the display name: %v", bodies[1])
	}
}

// The fallback is scoped to the missing column: any other refusal must surface,
// and a keys-only publish (no avatar to strip) must never be retried.
func TestUpsertIdentityDoesNotRetryOtherFailures(t *testing.T) {
	var writes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writes++
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"42501","message":"permission denied"}`))
	}))
	defer srv.Close()

	image := ""
	row := identityRow{UserID: "u1", PubEnc: "enc", PubSig: "sig", ImageURL: &image}
	if err := upsertIdentity(context.Background(), srv.Client(), srv.URL, "tok", row); err == nil {
		t.Fatal("a permission failure must surface")
	}
	if writes != 1 {
		t.Fatalf("expected no retry, got %d writes", writes)
	}
}
