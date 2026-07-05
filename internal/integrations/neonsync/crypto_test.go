package neonsync

import (
	"bytes"
	"testing"
)

func TestDeriveAuthHashDeterministic(t *testing.T) {
	a, err := DeriveAuthHash("User@Example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	// Same credentials -> same hash, including email normalization (case/space).
	b, err := DeriveAuthHash("  user@example.com ", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("auth hash not deterministic across email normalization: %q vs %q", a, b)
	}

	// Different password -> different hash.
	c, err := DeriveAuthHash("user@example.com", "wrong password")
	if err != nil {
		t.Fatal(err)
	}
	if a == c {
		t.Fatal("auth hash collided across different passwords")
	}

	// Different email -> different salt -> different hash.
	d, err := DeriveAuthHash("other@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if a == d {
		t.Fatal("auth hash collided across different emails")
	}
}

func TestDeriveAuthHashEmptyPassword(t *testing.T) {
	if _, err := DeriveAuthHash("user@example.com", ""); err == nil {
		t.Fatal("expected error for empty password")
	}
}

func TestKEKDeterministic(t *testing.T) {
	salt, err := GenerateSalt()
	if err != nil {
		t.Fatal(err)
	}
	k1 := DeriveKEK("hunter2", salt)
	k2 := DeriveKEK("hunter2", salt)
	if !bytes.Equal(k1, k2) {
		t.Fatal("KEK not deterministic for same password+salt")
	}
	if len(k1) != keyLen {
		t.Fatalf("KEK length = %d, want %d", len(k1), keyLen)
	}

	// Different salt -> different KEK, even with the same password.
	salt2, err := GenerateSalt()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(k1, DeriveKEK("hunter2", salt2)) {
		t.Fatal("KEK collided across different salts")
	}
	// Different password -> different KEK.
	if bytes.Equal(k1, DeriveKEK("hunter3", salt)) {
		t.Fatal("KEK collided across different passwords")
	}
}

func TestWrapUnwrapDEK(t *testing.T) {
	salt, _ := GenerateSalt()
	kek := DeriveKEK("pw", salt)
	dek, err := GenerateDEK()
	if err != nil {
		t.Fatal(err)
	}

	wrapped, nonce, err := WrapDEK(dek, kek)
	if err != nil {
		t.Fatal(err)
	}
	got, err := UnwrapDEK(wrapped, nonce, kek)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, dek) {
		t.Fatal("unwrapped DEK does not match original")
	}

	// Wrong KEK (wrong password) must fail, not silently return garbage.
	wrongKEK := DeriveKEK("not the password", salt)
	if _, err := UnwrapDEK(wrapped, nonce, wrongKEK); err == nil {
		t.Fatal("expected unwrap to fail with wrong KEK")
	}
}

func TestEncryptDecryptEntry(t *testing.T) {
	dek, _ := GenerateDEK()
	plaintext := []byte(`{"description":"write tests","project":"toki"}`)

	ciphertext, nonce, err := EncryptEntry(dek, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("write tests")) {
		t.Fatal("plaintext leaked into ciphertext")
	}

	got, err := DecryptEntry(dek, ciphertext, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatal("round-trip mismatch")
	}
}

func TestDecryptEntryTamperRejected(t *testing.T) {
	dek, _ := GenerateDEK()
	ciphertext, nonce, err := EncryptEntry(dek, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}

	tampered := bytes.Clone(ciphertext)
	tampered[0] ^= 0xff
	if _, err := DecryptEntry(dek, tampered, nonce); err == nil {
		t.Fatal("expected tampered ciphertext to be rejected")
	}

	badNonce := bytes.Clone(nonce)
	badNonce[0] ^= 0xff
	if _, err := DecryptEntry(dek, ciphertext, badNonce); err == nil {
		t.Fatal("expected altered nonce to be rejected")
	}

	// Wrong-size nonce is rejected explicitly rather than panicking.
	if _, err := DecryptEntry(dek, ciphertext, nonce[:8]); err == nil {
		t.Fatal("expected wrong-size nonce to be rejected")
	}
}

func TestEntryIDStableAndKeyed(t *testing.T) {
	dek, _ := GenerateDEK()
	canonical := []byte(`{"description":"a","project":"b"}`)

	id1 := EntryID(dek, canonical)
	id2 := EntryID(dek, canonical)
	if id1 != id2 {
		t.Fatal("entry id not stable for same DEK + content")
	}
	if len(id1) != 64 { // hex SHA-256
		t.Fatalf("entry id length = %d, want 64", len(id1))
	}

	// Different content -> different id.
	if id1 == EntryID(dek, []byte("different")) {
		t.Fatal("entry id collided across different content")
	}
	// Different DEK -> different id for the same content (keyed).
	other, _ := GenerateDEK()
	if id1 == EntryID(other, canonical) {
		t.Fatal("entry id not keyed by DEK")
	}
}

// TestTwoHoldersConverge models the merge invariant: two devices that share the
// same DEK (same password) derive identical ids for identical entries, so a
// union by id deduplicates cleanly.
func TestTwoHoldersConverge(t *testing.T) {
	salt, _ := GenerateSalt()
	kek := DeriveKEK("shared password", salt)
	dek, _ := GenerateDEK()
	wrapped, nonce, _ := WrapDEK(dek, kek)

	// Second device unwraps the same DEK from the shared server-stored blob.
	kek2 := DeriveKEK("shared password", salt)
	dek2, err := UnwrapDEK(wrapped, nonce, kek2)
	if err != nil {
		t.Fatal(err)
	}

	canonical := []byte(`{"description":"shared work"}`)
	if EntryID(dek, canonical) != EntryID(dek2, canonical) {
		t.Fatal("two holders of the same DEK produced different ids")
	}
}
