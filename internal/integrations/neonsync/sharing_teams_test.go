package neonsync

import (
	"crypto/sha256"
	"encoding/hex"
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
