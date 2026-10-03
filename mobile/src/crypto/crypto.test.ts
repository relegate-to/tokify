/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { describe, expect, it } from 'vitest';

import { bytesToHex, bytesToUtf8, fromBase64, hexToBytes, toBase64, utf8ToBytes } from './bytes';
import {
    ARGON,
    type Argon2id,
    authSalt,
    canonicalize,
    decryptOwnEntry,
    deriveAuthHash,
    deriveEntryDEK,
    deriveKEK,
    entryAAD,
    entryId,
    open,
    openTimer,
    parseCanonical,
    seal,
    sealTimer,
    timerAAD,
    unwrapDEK,
    type RunningTimer,
} from './sync';

const vectors = JSON.parse(
    readFileSync(
        fileURLToPath(new URL('../../../internal/integrations/neonsync/testdata/crypto-vectors.json', import.meta.url)),
        'utf8',
    ),
);

// Pure-JS Argon2id stands in for the native module; it is slow, hence the
// generous timeouts below.
const jsArgon2: Argon2id = async (password, salt) =>
    argon2idAsync(utf8ToBytes(password), salt, {
        t: ARGON.time,
        m: ARGON.memoryKiB,
        p: ARGON.parallelism,
        dkLen: ARGON.keyLen,
        maxmem: 2 ** 31,
    });

describe('crypto parity with the Go desktop', () => {
    it('uses the same Argon2id cost', () => {
        expect(vectors.argon2id).toEqual({
            time: ARGON.time,
            memory_kib: ARGON.memoryKiB,
            threads: ARGON.parallelism,
            key_len: ARGON.keyLen,
        });
    });

    for (const v of vectors.auth_hash) {
        it(`derives the auth salt and hash for ${JSON.stringify(v.email)}`, async () => {
            expect(bytesToHex(authSalt(v.email))).toBe(v.salt_hex);
            expect(await deriveAuthHash(jsArgon2, v.email, v.password)).toBe(v.auth_hash_b64);
        }, 120_000);
    }

    for (const v of vectors.kek) {
        it('derives the KEK from salt_enc', async () => {
            const kek = await deriveKEK(jsArgon2, v.password, hexToBytes(v.salt_enc_hex));
            expect(bytesToHex(kek)).toBe(v.kek_hex);
        }, 120_000);
    }

    for (const v of vectors.seal) {
        it(`seals and opens: ${v.label}`, () => {
            const key = hexToBytes(v.key_hex);
            const nonce = hexToBytes(v.nonce_hex);
            const { ciphertext } = seal(key, hexToBytes(v.plaintext_hex), undefined, nonce);
            expect(toBase64(ciphertext)).toBe(v.ciphertext_b64);
            expect(bytesToHex(unwrapDEK(key, v.ciphertext_b64, toBase64(nonce)))).toBe(v.plaintext_hex);
        });
    }

    for (const v of vectors.entries) {
        it(`matches the entry format for ${JSON.stringify(v.description)}`, () => {
            const dek = hexToBytes(v.dek_hex);
            const nonce = hexToBytes(v.nonce_hex);
            const canon = canonicalize({ description: v.description, project: v.project, start: v.start, end: v.end });
            expect(bytesToUtf8(canon)).toBe(v.canonical);
            expect(entryId(dek, canon)).toBe(v.entry_id);

            expect(toBase64(seal(dek, canon, undefined, nonce).ciphertext)).toBe(v.v1_ciphertext_b64);
            expect(bytesToHex(deriveEntryDEK(dek, v.entry_id))).toBe(v.entry_dek_hex);
            expect(bytesToUtf8(entryAAD(v.entry_id, v.owner_id))).toBe(v.entry_aad);
            const v2 = seal(deriveEntryDEK(dek, v.entry_id), canon, entryAAD(v.entry_id, v.owner_id), nonce);
            expect(toBase64(v2.ciphertext)).toBe(v.v2_ciphertext_b64);

            const want = { description: v.description, project: v.project, start: v.start, end: v.end };
            for (const ciphertext of [v.v1_ciphertext_b64, v.v2_ciphertext_b64]) {
                const row = { id: v.entry_id, ciphertext, nonce: toBase64(nonce) };
                expect(decryptOwnEntry(dek, v.owner_id, row)).toEqual(want);
            }
        });
    }

    for (const v of vectors.timers) {
        it('opens and reseals a desktop running timer without changing it', () => {
            const dek = hexToBytes(v.dek_hex);
            expect(bytesToUtf8(timerAAD(v.owner_id, v.version))).toBe(v.aad);
            const row = { user_id: v.owner_id, version: v.version, ciphertext: v.ciphertext_b64, nonce: toBase64(hexToBytes(v.nonce_hex)) };
            const timer = openTimer(dek, row);
            // The nanosecond start must survive untouched.
            expect(timer.s).toBe(JSON.parse(v.timer_json).s);

            const resealed = sealTimer(dek, v.owner_id, v.version, timer, hexToBytes(v.nonce_hex));
            expect(openTimer(dek, { ...row, ...resealed })).toEqual(timer);
            expect(() => openTimer(dek, { ...row, version: v.version + 1 })).toThrow();
        });
    }

    it('rejects a timer under the wrong key', () => {
        const timer: RunningTimer = { d: 'x', p: '', s: new Date().toISOString(), dev: 'phone' };
        const sealed = sealTimer(new Uint8Array(32).fill(1), 'u', 1, timer);
        expect(() => openTimer(new Uint8Array(32).fill(2), { user_id: 'u', version: 1, ...sealed })).toThrow();
    });

    it('round-trips base64 at every padding length', () => {
        for (let n = 0; n < 8; n++) {
            const b = Uint8Array.from({ length: n }, (_, i) => i * 37);
            expect(fromBase64(toBase64(b))).toEqual(b);
            expect(toBase64(b)).toBe(Buffer.from(b).toString('base64'));
        }
    });

    it('rejects a v1 entry opened with the wrong key', () => {
        const v = vectors.entries[0];
        expect(() => open(new Uint8Array(32), fromBase64(v.v1_ciphertext_b64), hexToBytes(v.nonce_hex))).toThrow();
        expect(parseCanonical(canonicalize({ description: 'a', project: '', start: 's', end: 'e' })).end).toBe('e');
    });
});

describe('bytesToUtf8', () => {
    it('matches TextDecoder on valid and invalid input', () => {
        const samples = [
            utf8ToBytes('plain'),
            utf8ToBytes('Café — naïve 🔑 ÆØÅ  '),
            Uint8Array.from([0xff, 0x41, 0xc3]),
            Uint8Array.from([0xe2, 0x82]),
            Uint8Array.from([0xed, 0xa0, 0x80]),
            Uint8Array.from([0xf0, 0x9f, 0x94]),
        ];
        for (const b of samples) expect(bytesToUtf8(b)).toBe(new TextDecoder().decode(b));
    });
});
