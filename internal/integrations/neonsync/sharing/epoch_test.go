package sharing

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	"github.com/stretchr/testify/require"
)

// buildChain constructs a valid signed epoch chain of n epochs for audience
// "aud", all signed by a single admin, returning announcements, sigs, and the
// parallel admin-key slice.
func buildChain(t *testing.T, admin ed25519.PrivateKey, n int) ([]EpochAnnouncement, [][]byte, []ed25519.PublicKey) {
	t.Helper()
	adminPub, _ := admin.Public().(ed25519.PublicKey)

	var anns []EpochAnnouncement
	var sigs [][]byte
	var pubs []ed25519.PublicKey
	prev := ""
	for i := 1; i <= n; i++ {
		epk, err := GenerateEpochKeypair()
		require.NoError(t, err)
		ann := EpochAnnouncement{
			AudienceID: "aud",
			Epoch:      i,
			EpochPub:   epk.PublicKey().Bytes(),
			PrevHash:   prev,
		}
		sig, err := SignAnnouncement(admin, ann)
		require.NoError(t, err)
		anns = append(anns, ann)
		sigs = append(sigs, sig)
		pubs = append(pubs, adminPub)

		h, err := ann.Hash()
		require.NoError(t, err)
		prev = h
	}
	return anns, sigs, pubs
}

func TestVerifyChainValid(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 4)
	require.NoError(t, VerifyChain(anns, sigs, pubs))
}

func TestVerifyChainSingleEpoch(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 1)
	require.Empty(t, anns[0].PrevHash)
	require.NoError(t, VerifyChain(anns, sigs, pubs))
}

func TestVerifyChainForkedPrevHashDetected(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 3)

	// Rewrite epoch 3's PrevHash to a forked value, then re-sign so the signature
	// still verifies — only the chain link is wrong.
	anns[2].PrevHash = "deadbeef"
	sigs[2], err = SignAnnouncement(admin, anns[2])
	require.NoError(t, err)

	err = VerifyChain(anns, sigs, pubs)
	require.Error(t, err)
	require.Contains(t, err.Error(), "epoch 3")
}

func TestVerifyChainGapDetected(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 3)

	// Drop epoch 2 -> positions become epochs 1, 3 (gap).
	anns = []EpochAnnouncement{anns[0], anns[2]}
	sigs = [][]byte{sigs[0], sigs[2]}
	pubs = []ed25519.PublicKey{pubs[0], pubs[2]}

	err = VerifyChain(anns, sigs, pubs)
	require.Error(t, err)
	require.Contains(t, err.Error(), "epoch 3")
}

func TestVerifyChainNonMonotonicDetected(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 3)

	// Swap epochs 2 and 3 so the sequence is 1, 3, 2.
	anns[1], anns[2] = anns[2], anns[1]
	sigs[1], sigs[2] = sigs[2], sigs[1]

	err = VerifyChain(anns, sigs, pubs)
	require.Error(t, err)
}

func TestVerifyChainNonEmptyFirstPrevHashDetected(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 2)

	anns[0].PrevHash = "notempty"
	sigs[0], err = SignAnnouncement(admin, anns[0])
	require.NoError(t, err)

	err = VerifyChain(anns, sigs, pubs)
	require.Error(t, err)
	require.Contains(t, err.Error(), "epoch 1")
}

func TestVerifyChainBadSignatureDetected(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 3)

	sigs[1] = bytes.Clone(sigs[1])
	sigs[1][0] ^= 0xff

	err = VerifyChain(anns, sigs, pubs)
	require.Error(t, err)
	require.Contains(t, err.Error(), "epoch 2")
}

func TestVerifyChainWrongAdminKeyDetected(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 2)

	wrongPub, _, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	pubs[1] = wrongPub

	err = VerifyChain(anns, sigs, pubs)
	require.Error(t, err)
	require.Contains(t, err.Error(), "epoch 2")
}

func TestVerifyChainLengthMismatch(t *testing.T) {
	_, admin, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	anns, sigs, pubs := buildChain(t, admin, 2)

	require.Error(t, VerifyChain(anns, sigs[:1], pubs))
	require.Error(t, VerifyChain(nil, nil, nil))
}

func TestAnnouncementSignRoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	epk, err := GenerateEpochKeypair()
	require.NoError(t, err)
	ann := EpochAnnouncement{AudienceID: "aud", Epoch: 1, EpochPub: epk.PublicKey().Bytes()}

	sig, err := SignAnnouncement(priv, ann)
	require.NoError(t, err)

	ok, err := VerifyAnnouncement(pub, ann, sig)
	require.NoError(t, err)
	require.True(t, ok)

	// Tamper the epoch pubkey.
	ann.EpochPub = bytes.Clone(ann.EpochPub)
	ann.EpochPub[0] ^= 0xff
	ok, err = VerifyAnnouncement(pub, ann, sig)
	require.NoError(t, err)
	require.False(t, ok)
}

// TestEpochWrappers exercises the three named seal wrappers end to end.
func TestEpochWrappers(t *testing.T) {
	member, err := GenerateIdentity()
	require.NoError(t, err)
	epoch, err := GenerateEpochKeypair()
	require.NoError(t, err)

	// Wrap epoch privkey to member, unwrap it back.
	ekAAD := EpochKeyAAD{AudienceID: "aud", Epoch: 2, MemberID: "m1"}
	wrappedEpoch, err := WrapEpochKeyToMember(member.Public().EncPub, epoch.Bytes(), ekAAD)
	require.NoError(t, err)
	gotEpoch, err := UnwrapEpochKeyForMember(member.EncPriv.Bytes(), wrappedEpoch, ekAAD)
	require.NoError(t, err)
	require.True(t, bytes.Equal(epoch.Bytes(), gotEpoch))

	// Wrong AAD (member id) must fail.
	badAAD := ekAAD
	badAAD.MemberID = "m2"
	_, err = UnwrapEpochKeyForMember(member.EncPriv.Bytes(), wrappedEpoch, badAAD)
	require.Error(t, err)

	// Wrap DEK to epoch, unwrap with epoch privkey.
	dek := newDEK(t)
	gAAD := GrantAAD{EntryID: "e1", AudienceID: "aud", Epoch: 2}
	wrappedDEK, err := WrapDEKToEpoch(epoch.PublicKey().Bytes(), dek, gAAD)
	require.NoError(t, err)
	gotDEK, err := UnwrapDEKFromEpoch(epoch.Bytes(), wrappedDEK, gAAD)
	require.NoError(t, err)
	require.True(t, bytes.Equal(dek, gotDEK))

	// Wrap filter to epoch, unwrap.
	fAAD := FilterAAD{AudienceID: "aud", Epoch: 2}
	filter := []byte(`{"tags":["work"]}`)
	wrappedFilter, err := WrapFilterToEpoch(epoch.PublicKey().Bytes(), filter, fAAD)
	require.NoError(t, err)
	gotFilter, err := UnwrapFilterFromEpoch(epoch.Bytes(), wrappedFilter, fAAD)
	require.NoError(t, err)
	require.True(t, bytes.Equal(filter, gotFilter))

	// Wrap team name to epoch, unwrap.
	nAAD := NameAAD{AudienceID: "aud", Epoch: 2}
	name := []byte("Acme client")
	wrappedName, err := WrapNameToEpoch(epoch.PublicKey().Bytes(), name, nAAD)
	require.NoError(t, err)
	gotName, err := UnwrapNameFromEpoch(epoch.Bytes(), wrappedName, nAAD)
	require.NoError(t, err)
	require.True(t, bytes.Equal(name, gotName))

	// Domain separation: a name ciphertext must NOT open as a filter under the
	// same (audience, epoch), or a server could swap the two blobs.
	_, err = UnwrapFilterFromEpoch(epoch.Bytes(), wrappedName, fAAD)
	require.Error(t, err)
	_, err = UnwrapNameFromEpoch(epoch.Bytes(), wrappedFilter, nAAD)
	require.Error(t, err)
}

// TestEpochAnnouncementCanonicalStable freezes the canonical encoding shape.
func TestEpochAnnouncementCanonicalStable(t *testing.T) {
	ann := EpochAnnouncement{AudienceID: "aud", Epoch: 1, EpochPub: []byte{0x01, 0x02}, PrevHash: ""}
	got, err := ann.Canonical()
	require.NoError(t, err)
	require.JSONEq(t, `{"audience_id":"aud","epoch":1,"epoch_pubkey":"AQI=","prev_epoch":""}`, string(got))
}
