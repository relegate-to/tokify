// TypeScript port of the desktop's sync crypto
// (internal/integrations/neonsync/crypto.go, running.go and sharing/payloads.go).
// Every output must match the Go code byte for byte; crypto.test.ts checks it
// against internal/integrations/neonsync/testdata/crypto-vectors.json.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from './bytes';
import { goObject } from './gojson';

export const ARGON = { time: 3, memoryKiB: 64 * 1024, parallelism: 4, keyLen: 32 } as const;
const SALT_LEN = 16;
const NONCE_LEN = 24;
const AUTH_INFO = 'tokify-sync-auth-salt-v1';
const ENTRY_DEK_DOMAIN = 'tokify-entry-dek-v1';
const ENTRY_VERSION = 1;

// Argon2id with the desktop's cost. Injected because the phone runs a native
// implementation and the tests run a pure-JS one; both are checked against the
// same vectors.
export type Argon2id = (password: string, salt: Uint8Array) => Promise<Uint8Array>;

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function authSalt(email: string): Uint8Array {
    return hkdf(sha256, utf8ToBytes(normalizeEmail(email)), undefined, utf8ToBytes(AUTH_INFO), SALT_LEN);
}

// The value sent to Neon Auth in place of the password.
export async function deriveAuthHash(argon2id: Argon2id, email: string, password: string): Promise<string> {
    if (password === '') throw new Error('password is empty');
    return toBase64(await argon2id(password, authSalt(email)));
}

export function deriveKEK(argon2id: Argon2id, password: string, saltEnc: Uint8Array): Promise<Uint8Array> {
    return argon2id(password, saltEnc);
}

export function seal(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array, nonce: Uint8Array = randomBytes(NONCE_LEN)) {
    return { ciphertext: xchacha20poly1305(key, nonce, aad).encrypt(plaintext), nonce };
}

// open throws on a wrong key, tampered ciphertext or mismatched AAD.
export function open(key: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, aad?: Uint8Array): Uint8Array {
    if (nonce.length !== NONCE_LEN) throw new Error('wrong nonce size');
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

export function unwrapDEK(kek: Uint8Array, wrappedB64: string, nonceB64: string): Uint8Array {
    return open(kek, fromBase64(wrappedB64), fromBase64(nonceB64));
}

// --- Entries ---------------------------------------------------------------

// A completed activity at the minute precision the sync format uses
// ("2006-01-02 15:04" in local time).
export type CanonicalEntry = { description: string; project: string; start: string; end: string };

export function canonicalize(e: CanonicalEntry): Uint8Array {
    return utf8ToBytes(goObject([['d', e.description], ['p', e.project], ['s', e.start], ['e', e.end]]));
}

export function parseCanonical(plain: Uint8Array): CanonicalEntry {
    const c = JSON.parse(bytesToUtf8(plain)) as { d: string; p: string; s: string; e: string };
    if (!c.e) throw new Error('pulled entry has no end time');
    return { description: c.d, project: c.p, start: c.s, end: c.e };
}

export function entryId(dek: Uint8Array, canonical: Uint8Array): string {
    return bytesToHex(hmac(sha256, dek, canonical));
}

export function deriveEntryDEK(accountDEK: Uint8Array, id: string): Uint8Array {
    return hkdf(sha256, accountDEK, undefined, utf8ToBytes(ENTRY_DEK_DOMAIN + ':' + id), 32);
}

export function entryAAD(id: string, ownerId: string): Uint8Array {
    return utf8ToBytes(goObject([['entry_id', id], ['version', ENTRY_VERSION], ['author_id', ownerId]]));
}

// Decrypts one of the caller's own entry rows: the v2 format (per-entry DEK,
// AAD-bound) first, then the legacy account-DEK format.
export function decryptOwnEntry(dek: Uint8Array, ownerId: string, row: { id: string; ciphertext: string; nonce: string }) {
    const ct = fromBase64(row.ciphertext);
    const nonce = fromBase64(row.nonce);
    try {
        return parseCanonical(open(deriveEntryDEK(dek, row.id), ct, nonce, entryAAD(row.id, ownerId)));
    } catch {
        return parseCanonical(open(dek, ct, nonce));
    }
}

// --- Running timer -----------------------------------------------------------

// The wire shape of neonsync.RunningTimer. Times stay the exact strings Go
// wrote (RFC 3339 with nanoseconds): desktops match timers by start instant, so
// rounding one through Date would turn it into a different timer.
export type RunningTimer = {
    d: string;
    p: string;
    n?: string;
    t?: string[];
    s: string;
    e?: string;
    x?: boolean;
    dev: string;
};

export function timerAAD(ownerId: string, version: number): Uint8Array {
    return utf8ToBytes(`tokify/running-timer/v1\0${ownerId}\0${version}`);
}

export function sealTimer(dek: Uint8Array, ownerId: string, version: number, timer: RunningTimer, nonce?: Uint8Array) {
    const { ciphertext, nonce: n } = seal(dek, utf8ToBytes(JSON.stringify(timer)), timerAAD(ownerId, version), nonce);
    return { ciphertext: toBase64(ciphertext), nonce: toBase64(n) };
}

export function openTimer(dek: Uint8Array, row: { user_id: string; version: number; ciphertext: string; nonce: string }): RunningTimer {
    const plain = open(dek, fromBase64(row.ciphertext), fromBase64(row.nonce), timerAAD(row.user_id, row.version));
    return JSON.parse(bytesToUtf8(plain)) as RunningTimer;
}
