package sharing

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// testdata/sharing-vectors.json pins the sharing crypto for the mobile app's
// TypeScript port, which checks itself against the same file. Canonical bytes
// and Ed25519 signatures are deterministic and must match exactly; sealed boxes
// carry a random ephemeral key, so they are recorded once and the other side
// proves it can open them. Regenerate with:
// go test ./internal/integrations/neonsync/sharing -run Vectors -update
var updateVectors = flag.Bool("update", false, "rewrite testdata/sharing-vectors.json")

type sharingVectors struct {
	Identities []identityVector `json:"identities"`
	Canonical  canonicalVector  `json:"canonical"`
	Signatures []sigVector      `json:"signatures"`
	Seals      []sealedVector   `json:"seals"`
	Wraps      []wrapVector     `json:"wraps"`
	Chain      []chainVector    `json:"chain"`
}

type identityVector struct {
	EncPrivHex  string `json:"enc_priv_hex"`
	SigSeedHex  string `json:"sig_seed_hex"`
	EncPub      string `json:"enc_pub_b64"`
	SigPub      string `json:"sig_pub_b64"`
	Fingerprint string `json:"fingerprint"`
}

type canonicalVector struct {
	EntryAAD    string `json:"entry_aad"`
	GrantAAD    string `json:"grant_aad"`
	EpochKeyAAD string `json:"epoch_key_aad"`
	FilterAAD   string `json:"filter_aad"`
	NameAAD     string `json:"name_aad"`
	EntrySig    string `json:"entry_sig_bytes"`
	GrantSig    string `json:"grant_sig_bytes"`
	Epoch       string `json:"epoch"`
	EpochHash   string `json:"epoch_hash"`
}

// sigVector is one domain-separated signature by identities[0].
type sigVector struct {
	Domain    string `json:"domain"`
	Canonical string `json:"canonical"`
	Sig       string `json:"sig_b64"`
}

// sealedVector is a SealTo wire for identities[Recipient].
type sealedVector struct {
	Label     string `json:"label"`
	Recipient int    `json:"recipient"`
	AAD       string `json:"aad"`
	Plaintext string `json:"plaintext_hex"`
	Wire      string `json:"wire_b64"`
}

// wrapVector is a symmetric two-column wrap (identity under a KEK, pins under
// the account DEK).
type wrapVector struct {
	Kind       string `json:"kind"`
	KeyHex     string `json:"key_hex"`
	UserID     string `json:"user_id"`
	Plaintext  string `json:"plaintext"`
	Ciphertext string `json:"ciphertext_b64"`
	Nonce      string `json:"nonce_b64"`
}

// chainVector is an epoch announcement signed by identities[0].
type chainVector struct {
	AudienceID string `json:"audience_id"`
	Epoch      int    `json:"epoch"`
	EpochPub   string `json:"epoch_pub_b64"`
	PrevHash   string `json:"prev_hash"`
	Hash       string `json:"hash"`
	Sig        string `json:"sig_b64"`
}

func fixedIdentity(t *testing.T, encHex, seedHex string) (*Identity, identityVector) {
	t.Helper()
	encRaw, _ := hex.DecodeString(encHex)
	seed, _ := hex.DecodeString(seedHex)
	enc, err := ecdh.X25519().NewPrivateKey(encRaw)
	if err != nil {
		t.Fatal(err)
	}
	id := &Identity{EncPriv: enc, SigPriv: ed25519.NewKeyFromSeed(seed)}
	pub := id.Public()
	return id, identityVector{
		EncPrivHex: encHex, SigSeedHex: seedHex,
		EncPub: b64(pub.EncPub), SigPub: b64(pub.SigPub), Fingerprint: Fingerprint(pub),
	}
}

// mustBytes turns a (bytes, error) pair into a string, failing the test on error.
func mustBytes(t *testing.T) func([]byte, error) string {
	return func(b []byte, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
}

func buildSharingVectors(t *testing.T) sharingVectors {
	t.Helper()
	var v sharingVectors
	must := mustBytes(t)
	alice, av := fixedIdentity(t,
		"58a1d2b4c6e8f00112233445566778899aabbccddeeff00112233445566778f0",
		"9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	_, bv := fixedIdentity(t,
		"a8b9cadbecfd0e1f2031425364758697a8b9cadbecfd0e1f2031425364758657",
		"4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
	v.Identities = []identityVector{av, bv}

	const (
		entryID  = "3f2a6c1d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a29"
		audience = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
		author   = "user-alice"
		member   = "user-bob"
	)
	ciphertext := []byte("ciphertext <&> bytes")
	wrappedDEK := []byte("wrapped-dek-wire")
	entryAAD := EntryAAD{EntryID: entryID, Version: 1, AuthorID: author}
	grantAAD := GrantAAD{EntryID: entryID, AudienceID: audience, Epoch: 2}
	epochKeyAAD := EpochKeyAAD{AudienceID: audience, Epoch: 2, MemberID: member}
	filterAAD := FilterAAD{AudienceID: audience, Epoch: 2}
	nameAAD := NameAAD{AudienceID: audience, Epoch: 2}

	c := &v.Canonical
	c.EntryAAD = must(EntryAADBytes(entryAAD))
	c.GrantAAD = must(GrantAADBytes(grantAAD))
	c.EpochKeyAAD = must(EpochKeyAADBytes(epochKeyAAD))
	c.FilterAAD = must(FilterAADBytes(filterAAD))
	c.NameAAD = must(NameAADBytes(nameAAD))
	c.EntrySig = must(EntrySigBytes(entryAAD, ciphertext))
	c.GrantSig = must(GrantSigBytes(grantAAD, wrappedDEK))

	epochPrivRaw, _ := hex.DecodeString("c0ffee0123456789abcdef0123456789abcdef0123456789abcdef0123456740")
	epochPriv, err := ecdh.X25519().NewPrivateKey(epochPrivRaw)
	if err != nil {
		t.Fatal(err)
	}
	ann1 := EpochAnnouncement{AudienceID: audience, Epoch: 1, EpochPub: epochPriv.PublicKey().Bytes()}
	c.Epoch = must(ann1.Canonical())
	c.EpochHash, err = ann1.Hash()
	if err != nil {
		t.Fatal(err)
	}

	sign := func(domain, canonical string) {
		v.Signatures = append(v.Signatures, sigVector{
			Domain: domain, Canonical: canonical,
			Sig: b64(signPayload(alice.SigPriv, domain, []byte(canonical))),
		})
	}
	sign(domainEntry, c.EntrySig)
	sign(domainGrant, c.GrantSig)
	sign(domainEpoch, c.Epoch)

	// A two-epoch chain, the second linked to the first.
	ann2 := EpochAnnouncement{AudienceID: audience, Epoch: 2, EpochPub: av.encPubBytes(t), PrevHash: c.EpochHash}
	for _, ann := range []EpochAnnouncement{ann1, ann2} {
		sig, serr := SignAnnouncement(alice.SigPriv, ann)
		if serr != nil {
			t.Fatal(serr)
		}
		h, herr := ann.Hash()
		if herr != nil {
			t.Fatal(herr)
		}
		v.Chain = append(v.Chain, chainVector{
			AudienceID: ann.AudienceID, Epoch: ann.Epoch, EpochPub: b64(ann.EpochPub),
			PrevHash: ann.PrevHash, Hash: h, Sig: b64(sig),
		})
	}

	seal := func(label string, recipient int, plaintext []byte, aad string) {
		pub, _ := base64.StdEncoding.DecodeString(v.Identities[recipient].EncPub)
		wire, serr := SealTo(pub, plaintext, []byte(aad))
		if serr != nil {
			t.Fatal(serr)
		}
		v.Seals = append(v.Seals, sealedVector{
			Label: label, Recipient: recipient, AAD: aad, Plaintext: hex.EncodeToString(plaintext), Wire: b64(wire),
		})
	}
	seal("epoch key to member", 1, epochPrivRaw, c.EpochKeyAAD)
	seal("dek to epoch", 0, bytes.Repeat([]byte{0x42}, 32), c.GrantAAD)
	seal("filter to epoch", 0, []byte(`{"projects":["Client Work"],"since_days":30}`), c.FilterAAD)
	seal("name to epoch", 0, []byte("Design team"), c.NameAAD)

	kek := bytes.Repeat([]byte{0x17}, 32)
	ct, nonce, err := WrapIdentity(alice, kek, author)
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := marshalCanonical(wrappedIdentity{EncPriv: b64(alice.EncPriv.Bytes()), SigPriv: b64(alice.SigPriv)})
	v.Wraps = append(v.Wraps, wrapVector{
		Kind: "identity", KeyHex: hex.EncodeToString(kek), UserID: author,
		Plaintext: string(blob), Ciphertext: b64(ct), Nonce: b64(nonce),
	})
	dek := bytes.Repeat([]byte{0x29}, 32)
	pins := `{"fingerprints":{"user-bob":"` + bv.Fingerprint + `"},"epochs":{"` + audience + `":2},"joined":{"` + audience + `":true},"joined_seeded":true}`
	ct, nonce, err = WrapPins([]byte(pins), dek, author)
	if err != nil {
		t.Fatal(err)
	}
	v.Wraps = append(v.Wraps, wrapVector{
		Kind: "pins", KeyHex: hex.EncodeToString(dek), UserID: author,
		Plaintext: pins, Ciphertext: b64(ct), Nonce: b64(nonce),
	})
	return v
}

func (v identityVector) encPubBytes(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(v.EncPub)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSharingVectors(t *testing.T) {
	path := filepath.Join("testdata", "sharing-vectors.json")
	if *updateVectors {
		data, err := json.MarshalIndent(buildSharingVectors(t), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors (regenerate with -update): %v", err)
	}
	must := mustBytes(t)
	var stored sharingVectors
	if err = json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}

	// Everything deterministic must still come out the same.
	fresh := buildSharingVectors(t)
	if got, want := must(json.Marshal(fresh.Identities)), must(json.Marshal(stored.Identities)); got != want {
		t.Errorf("identities changed:\n got %s\nwant %s", got, want)
	}
	if fresh.Canonical != stored.Canonical {
		t.Errorf("canonical bytes changed:\n got %+v\nwant %+v", fresh.Canonical, stored.Canonical)
	}
	if got, want := must(json.Marshal(fresh.Signatures)), must(json.Marshal(stored.Signatures)); got != want {
		t.Errorf("signatures changed")
	}
	if got, want := must(json.Marshal(fresh.Chain)), must(json.Marshal(stored.Chain)); got != want {
		t.Errorf("epoch chain changed")
	}

	// The recorded seals and wraps must still open.
	for _, s := range stored.Seals {
		priv, _ := hex.DecodeString(stored.Identities[s.Recipient].EncPrivHex)
		wire, _ := base64.StdEncoding.DecodeString(s.Wire)
		plain, oerr := OpenSealed(priv, wire, []byte(s.AAD))
		if oerr != nil || hex.EncodeToString(plain) != s.Plaintext {
			t.Errorf("seal %q no longer opens: %v", s.Label, oerr)
		}
	}
	for _, w := range stored.Wraps {
		key, _ := hex.DecodeString(w.KeyHex)
		ct, _ := base64.StdEncoding.DecodeString(w.Ciphertext)
		nonce, _ := base64.StdEncoding.DecodeString(w.Nonce)
		switch w.Kind {
		case "identity":
			if _, uerr := UnwrapIdentity(ct, nonce, key, w.UserID); uerr != nil {
				t.Errorf("identity wrap no longer opens: %v", uerr)
			}
		case "pins":
			blob, uerr := UnwrapPins(ct, nonce, key, w.UserID)
			if uerr != nil || string(blob) != w.Plaintext {
				t.Errorf("pins wrap no longer opens: %v", uerr)
			}
		}
	}
}
