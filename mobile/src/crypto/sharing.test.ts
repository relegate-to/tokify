/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bytesToHex, bytesToUtf8, fromBase64, hexToBytes, toBase64, utf8ToBytes } from './bytes';
import {
    entryAADBytes,
    entrySigBytes,
    epochCanonical,
    epochHash,
    epochKeyAADBytes,
    filterAADBytes,
    fingerprint,
    grantAADBytes,
    grantSigBytes,
    nameAADBytes,
    openSealed,
    publicIdentity,
    sealTo,
    signAnnouncement,
    signPayload,
    unwrapIdentity,
    unwrapPins,
    verifyChain,
    verifyPayload,
    wrapIdentity,
    wrapPins,
    type Identity,
} from './sharing';

const vectors = JSON.parse(
    readFileSync(
        fileURLToPath(new URL('../../../internal/integrations/neonsync/sharing/testdata/sharing-vectors.json', import.meta.url)),
        'utf8',
    ),
);

const identities: Identity[] = vectors.identities.map((v: { enc_priv_hex: string; sig_seed_hex: string }) => ({
    encPriv: hexToBytes(v.enc_priv_hex),
    sigSeed: hexToBytes(v.sig_seed_hex),
}));

// The fixed inputs buildSharingVectors uses (sharing/vectors_test.go).
const ENTRY = '3f2a6c1d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a29';
const AUDIENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('sharing crypto parity with the Go desktop', () => {
    it('derives the same public keys and fingerprints', () => {
        vectors.identities.forEach((v: { enc_pub_b64: string; sig_pub_b64: string; fingerprint: string }, i: number) => {
            const pub = publicIdentity(identities[i]);
            expect(toBase64(pub.encPub)).toBe(v.enc_pub_b64);
            expect(toBase64(pub.sigPub)).toBe(v.sig_pub_b64);
            expect(fingerprint(pub)).toBe(v.fingerprint);
        });
    });

    it('encodes canonical AAD and signing bytes identically', () => {
        const c = vectors.canonical;
        const dec = bytesToUtf8;
        expect(dec(entryAADBytes({ entryId: ENTRY, version: 1, authorId: 'user-alice' }))).toBe(c.entry_aad);
        expect(dec(grantAADBytes({ entryId: ENTRY, audienceId: AUDIENCE, epoch: 2 }))).toBe(c.grant_aad);
        expect(dec(epochKeyAADBytes({ audienceId: AUDIENCE, epoch: 2, memberId: 'user-bob' }))).toBe(c.epoch_key_aad);
        expect(dec(filterAADBytes({ audienceId: AUDIENCE, epoch: 2 }))).toBe(c.filter_aad);
        expect(dec(nameAADBytes({ audienceId: AUDIENCE, epoch: 2 }))).toBe(c.name_aad);
        expect(dec(entrySigBytes({ entryId: ENTRY, version: 1, authorId: 'user-alice' }, utf8ToBytes('ciphertext <&> bytes')))).toBe(c.entry_sig_bytes);
        expect(dec(grantSigBytes({ entryId: ENTRY, audienceId: AUDIENCE, epoch: 2 }, utf8ToBytes('wrapped-dek-wire')))).toBe(c.grant_sig_bytes);
    });

    it('signs exactly as Go does and verifies Go signatures', () => {
        const pub = publicIdentity(identities[0]).sigPub;
        for (const s of vectors.signatures) {
            const canonical = utf8ToBytes(s.canonical);
            expect(toBase64(signPayload(identities[0], s.domain, canonical))).toBe(s.sig_b64);
            expect(verifyPayload(pub, s.domain, canonical, fromBase64(s.sig_b64))).toBe(true);
            expect(verifyPayload(pub, s.domain + 'x', canonical, fromBase64(s.sig_b64))).toBe(false);
        }
    });

    it('verifies the epoch chain and its hashes', () => {
        const anns = vectors.chain.map((c: { audience_id: string; epoch: number; epoch_pub_b64: string; prev_hash: string }) => ({
            audienceId: c.audience_id,
            epoch: c.epoch,
            epochPub: fromBase64(c.epoch_pub_b64),
            prevHash: c.prev_hash,
        }));
        expect(bytesToUtf8(epochCanonical(anns[0]))).toBe(vectors.canonical.epoch);
        anns.forEach((a: (typeof anns)[number], i: number) => {
            expect(epochHash(a)).toBe(vectors.chain[i].hash);
            expect(toBase64(signAnnouncement(identities[0], a))).toBe(vectors.chain[i].sig_b64);
        });
        const sigs = vectors.chain.map((c: { sig_b64: string }) => fromBase64(c.sig_b64));
        const admin = publicIdentity(identities[0]).sigPub;
        expect(() => verifyChain(anns, sigs, [admin, admin])).not.toThrow();
        expect(() => verifyChain([anns[1]], [sigs[1]], [admin])).toThrow(/non-contiguous/);
        expect(() => verifyChain(anns, [sigs[1], sigs[0]], [admin, admin])).toThrow(/bad admin signature/);
        const other = publicIdentity(identities[1]).sigPub;
        expect(() => verifyChain(anns, sigs, [admin, other])).toThrow(/bad admin signature/);
    });

    it('opens sealed boxes Go made and round-trips its own', () => {
        for (const s of vectors.seals) {
            const priv = identities[s.recipient].encPriv;
            expect(bytesToHex(openSealed(priv, fromBase64(s.wire_b64), utf8ToBytes(s.aad)))).toBe(s.plaintext_hex);
            expect(() => openSealed(priv, fromBase64(s.wire_b64), utf8ToBytes(s.aad + ' '))).toThrow();
            const wire = sealTo(publicIdentity(identities[s.recipient]).encPub, hexToBytes(s.plaintext_hex), utf8ToBytes(s.aad));
            expect(bytesToHex(openSealed(priv, wire, utf8ToBytes(s.aad)))).toBe(s.plaintext_hex);
        }
    });

    it('unwraps the identity and pin store Go wrapped, and rewraps them the same way', () => {
        const idWrap = vectors.wraps.find((w: { kind: string }) => w.kind === 'identity');
        const id = unwrapIdentity(hexToBytes(idWrap.key_hex), idWrap.user_id, idWrap.ciphertext_b64, idWrap.nonce_b64);
        expect(bytesToHex(id.encPriv)).toBe(vectors.identities[0].enc_priv_hex);
        expect(bytesToHex(id.sigSeed)).toBe(vectors.identities[0].sig_seed_hex);
        expect(() => unwrapIdentity(hexToBytes(idWrap.key_hex), 'someone-else', idWrap.ciphertext_b64, idWrap.nonce_b64)).toThrow();
        const rewrapped = wrapIdentity(id, hexToBytes(idWrap.key_hex), idWrap.user_id);
        const back = unwrapIdentity(hexToBytes(idWrap.key_hex), idWrap.user_id, toBase64(rewrapped.ciphertext), toBase64(rewrapped.nonce));
        expect(bytesToHex(back.sigSeed)).toBe(vectors.identities[0].sig_seed_hex);

        const pinWrap = vectors.wraps.find((w: { kind: string }) => w.kind === 'pins');
        expect(bytesToUtf8(unwrapPins(hexToBytes(pinWrap.key_hex), pinWrap.user_id, pinWrap.ciphertext_b64, pinWrap.nonce_b64))).toBe(pinWrap.plaintext);
        const pins = wrapPins(utf8ToBytes(pinWrap.plaintext), hexToBytes(pinWrap.key_hex), pinWrap.user_id);
        expect(bytesToUtf8(unwrapPins(hexToBytes(pinWrap.key_hex), pinWrap.user_id, toBase64(pins.ciphertext), toBase64(pins.nonce)))).toBe(pinWrap.plaintext);
    });
});
