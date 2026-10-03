package neonsync

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/kriuchkov/tock/internal/core/models"
	"github.com/kriuchkov/tock/internal/integrations/neonsync/sharing"
)

// testdata/crypto-vectors.json pins the sync crypto to fixed inputs and
// outputs. The mobile app's TypeScript port checks itself against the same
// file, so a change on either side that alters the bytes fails one of the two
// suites. Regenerate with: go test ./internal/integrations/neonsync -run Vectors -update
var updateVectors = flag.Bool("update", false, "rewrite testdata/crypto-vectors.json")

type cryptoVectors struct {
	Argon struct {
		Time    uint32 `json:"time"`
		Memory  uint32 `json:"memory_kib"`
		Threads uint8  `json:"threads"`
		KeyLen  uint32 `json:"key_len"`
	} `json:"argon2id"`
	AuthHash []authHashVector `json:"auth_hash"`
	KEK      []kekVector      `json:"kek"`
	Seal     []sealVector     `json:"seal"`
	Entries  []entryVector    `json:"entries"`
	Timers   []timerVector    `json:"timers"`
}

type authHashVector struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	SaltHex  string `json:"salt_hex"`
	AuthHash string `json:"auth_hash_b64"`
}

type kekVector struct {
	Password   string `json:"password"`
	SaltEncHex string `json:"salt_enc_hex"`
	KEKHex     string `json:"kek_hex"`
}

// sealVector is one XChaCha20-Poly1305 seal with a fixed nonce; it covers DEK
// wrapping (key = KEK, plaintext = DEK) as well as the generic primitive.
type sealVector struct {
	Label        string `json:"label"`
	KeyHex       string `json:"key_hex"`
	NonceHex     string `json:"nonce_hex"`
	PlaintextHex string `json:"plaintext_hex"`
	AADHex       string `json:"aad_hex"`
	Ciphertext   string `json:"ciphertext_b64"`
}

type entryVector struct {
	Description  string `json:"description"`
	Project      string `json:"project"`
	Start        string `json:"start"`
	End          string `json:"end"`
	Canonical    string `json:"canonical"`
	DEKHex       string `json:"dek_hex"`
	EntryID      string `json:"entry_id"`
	OwnerID      string `json:"owner_id"`
	EntryDEKHex  string `json:"entry_dek_hex"`
	EntryAAD     string `json:"entry_aad"`
	NonceHex     string `json:"nonce_hex"`
	V1Ciphertext string `json:"v1_ciphertext_b64"`
	V2Ciphertext string `json:"v2_ciphertext_b64"`
}

type timerVector struct {
	DEKHex     string `json:"dek_hex"`
	OwnerID    string `json:"owner_id"`
	Version    int64  `json:"version"`
	Timer      string `json:"timer_json"`
	AAD        string `json:"aad"`
	NonceHex   string `json:"nonce_hex"`
	Ciphertext string `json:"ciphertext_b64"`
}

func fixedBytes(seed byte, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = seed + byte(i)
	}
	return b
}

func sealFixed(t *testing.T, key, nonce, plaintext, aad []byte) string {
	t.Helper()
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		t.Fatal(err)
	}
	return b64(aead.Seal(nil, nonce, plaintext, aad))
}

func buildVectors(t *testing.T) cryptoVectors {
	t.Helper()
	var v cryptoVectors
	v.Argon.Time, v.Argon.Memory, v.Argon.Threads, v.Argon.KeyLen = argonTime, argonMemory, argonThreads, keyLen

	for _, c := range []struct{ email, password string }{
		{"sam@example.com", "correct horse battery staple"},
		{"  Sam.Finch@Example.COM ", "pässwörd 🔑"},
	} {
		hash, err := DeriveAuthHash(c.email, c.password)
		if err != nil {
			t.Fatal(err)
		}
		v.AuthHash = append(v.AuthHash, authHashVector{
			Email: c.email, Password: c.password,
			SaltHex: hex.EncodeToString(hkdfSalt(normalizeEmail(c.email))), AuthHash: hash,
		})
	}

	saltEnc := fixedBytes(0x10, saltEncLen)
	kek := DeriveKEK("correct horse battery staple", saltEnc)
	v.KEK = append(v.KEK, kekVector{
		Password: "correct horse battery staple", SaltEncHex: hex.EncodeToString(saltEnc), KEKHex: hex.EncodeToString(kek),
	})

	dek := fixedBytes(0x40, keyLen)
	nonce := fixedBytes(0x80, chacha20poly1305.NonceSizeX)
	v.Seal = append(v.Seal, sealVector{
		Label: "wrap DEK under KEK", KeyHex: hex.EncodeToString(kek), NonceHex: hex.EncodeToString(nonce),
		PlaintextHex: hex.EncodeToString(dek), Ciphertext: sealFixed(t, kek, nonce, dek, nil),
	})

	for _, c := range []struct{ desc, project string }{
		{"Write plan", "tokify"},
		{`Fix <script> & "quotes" in names`, ""},
		{"Café review — naïve résumé", "Clients/ÆØÅ"},
		{"Tab\there\u2028next\x01\b\f\\end\x7f", ""},
	} {
		start := time.Date(2026, 10, 1, 9, 30, 0, 0, time.Local)
		end := start.Add(95 * time.Minute)
		canon := canonicalize(models.Activity{Description: c.desc, Project: c.project, StartTime: start, EndTime: &end})
		id := EntryID(dek, canon)
		owner := "user-123"
		entryDEK, err := sharing.DeriveEntryDEK(dek, id)
		if err != nil {
			t.Fatal(err)
		}
		aad, err := sharing.EntryAADBytes(sharing.EntryAAD{EntryID: id, Version: entryVersion, AuthorID: owner})
		if err != nil {
			t.Fatal(err)
		}
		v.Entries = append(v.Entries, entryVector{
			Description: c.desc, Project: c.project,
			Start: start.Format(syncTimeLayout), End: end.Format(syncTimeLayout),
			Canonical: string(canon), DEKHex: hex.EncodeToString(dek), EntryID: id, OwnerID: owner,
			EntryDEKHex: hex.EncodeToString(entryDEK), EntryAAD: string(aad), NonceHex: hex.EncodeToString(nonce),
			V1Ciphertext: sealFixed(t, dek, nonce, canon, nil),
			V2Ciphertext: sealFixed(t, entryDEK, nonce, canon, aad),
		})
	}

	start := time.Date(2026, 10, 1, 9, 30, 15, 123456789, time.FixedZone("BST", 3600))
	stopped := start.Add(time.Hour)
	for _, timer := range []RunningTimer{
		{Description: "Plan the release", Project: "tokify", Tags: []string{"docs"}, Start: start, DeviceID: "mac"},
		{Description: "Plan the release", Project: "tokify", Start: start, End: &stopped, DeviceID: "mac"},
	} {
		plain, err := json.Marshal(timer)
		if err != nil {
			t.Fatal(err)
		}
		aad := timerAAD("user-123", 7)
		v.Timers = append(v.Timers, timerVector{
			DEKHex: hex.EncodeToString(dek), OwnerID: "user-123", Version: 7, Timer: string(plain), AAD: string(aad),
			NonceHex: hex.EncodeToString(nonce), Ciphertext: sealFixed(t, dek, nonce, plain, aad),
		})
	}
	return v
}

func TestCryptoVectors(t *testing.T) {
	// canonicalize formats in local time; pin it so the vectors are stable.
	local := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = local })

	got, err := json.MarshalIndent(buildVectors(t), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := filepath.Join("testdata", "crypto-vectors.json")
	if *updateVectors {
		if err = os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (regenerate with -update)", err)
	}
	if string(got) != string(want) {
		t.Fatal("sync crypto output no longer matches testdata/crypto-vectors.json; " +
			"if the change is intended, regenerate with -update and update the mobile port")
	}
}
