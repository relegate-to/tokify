// TypeScript port of the desktop's sharing crypto core
// (internal/integrations/neonsync/sharing). Canonical bytes and signatures must
// match the Go code exactly; sharing.test.ts checks them against
// internal/integrations/neonsync/sharing/testdata/sharing-vectors.json.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { bytesToHex, bytesToUtf8, concatBytes, fromBase64, toBase64, utf8ToBytes } from './bytes';
import { goObject, goString } from './gojson';
import { open, seal } from './sync';

// Domain-separation constants, frozen in the Go package.
export const DOMAIN = {
    entry: 'tokify-share-entry-v1',
    grant: 'tokify-share-grant-v1',
    epoch: 'tokify-share-epoch-v1',
    seal: 'tokify-share-seal-v1',
} as const;

const KEY_LEN = 32;
const NONCE_LEN = 24;

// An identity's private halves: the X25519 scalar and the Ed25519 seed. Go keeps
// the 64-byte Ed25519 private key (seed then public key); only the seed matters.
export type Identity = { encPriv: Uint8Array; sigSeed: Uint8Array };
export type PublicIdentity = { encPub: Uint8Array; sigPub: Uint8Array };

export function generateIdentity(): Identity {
    return { encPriv: x25519.utils.randomSecretKey(), sigSeed: ed25519.utils.randomSecretKey() };
}

export function publicIdentity(id: Identity): PublicIdentity {
    return { encPub: x25519.getPublicKey(id.encPriv), sigPub: ed25519.getPublicKey(id.sigSeed) };
}

// Go's ed25519.PrivateKey: seed || public key.
function goSigPriv(id: Identity) {
    return concatBytes(id.sigSeed, ed25519.getPublicKey(id.sigSeed));
}

// SHA-256(encPub || sigPub), the leading 16 bytes as 8 groups of 4 hex digits.
export function fingerprint(pub: PublicIdentity): string {
    const hex = bytesToHex(sha256(concatBytes(pub.encPub, pub.sigPub)));
    return Array.from({ length: 8 }, (_, i) => hex.slice(i * 4, i * 4 + 4)).join(' ');
}

// --- Canonical encodings ------------------------------------------------------

const json = (fields: [string, string | number][]) => utf8ToBytes(goObject(fields));

export type EntryAAD = { entryId: string; version: number; authorId: string };
export type GrantAAD = { entryId: string; audienceId: string; epoch: number };
export type EpochKeyAAD = { audienceId: string; epoch: number; memberId: string };
export type FilterAAD = { audienceId: string; epoch: number };

export const entryAADBytes = (a: EntryAAD) => json([['entry_id', a.entryId], ['version', a.version], ['author_id', a.authorId]]);
export const grantAADBytes = (a: GrantAAD) => json([['entry_id', a.entryId], ['audience_id', a.audienceId], ['epoch', a.epoch]]);
export const epochKeyAADBytes = (a: EpochKeyAAD) => json([['audience_id', a.audienceId], ['epoch', a.epoch], ['member_id', a.memberId]]);
export const filterAADBytes = (a: FilterAAD) => json([['audience_id', a.audienceId], ['epoch', a.epoch]]);
// The same tuple as the filter's, kept apart by a fixed kind.
export const nameAADBytes = (a: FilterAAD) => json([['audience_id', a.audienceId], ['epoch', a.epoch], ['kind', 'team_name']]);

export const entrySigBytes = (a: EntryAAD, ciphertext: Uint8Array) =>
    json([['entry_id', a.entryId], ['version', a.version], ['author_id', a.authorId], ['ciphertext', toBase64(ciphertext)]]);
export const grantSigBytes = (a: GrantAAD, wrappedDEK: Uint8Array) =>
    json([['entry_id', a.entryId], ['audience_id', a.audienceId], ['epoch', a.epoch], ['wrapped_dek', toBase64(wrappedDEK)]]);

// --- Signatures ----------------------------------------------------------------

const signingInput = (domain: string, canonical: Uint8Array) => concatBytes(utf8ToBytes(domain + '\n'), canonical);

export function signPayload(id: Identity, domain: string, canonical: Uint8Array) {
    return ed25519.sign(signingInput(domain, canonical), id.sigSeed);
}

export function verifyPayload(sigPub: Uint8Array, domain: string, canonical: Uint8Array, sig: Uint8Array) {
    if (sigPub.length !== 32) return false;
    try {
        return ed25519.verify(sig, signingInput(domain, canonical), sigPub);
    } catch {
        return false;
    }
}

export const signEntry = (id: Identity, a: EntryAAD, ct: Uint8Array) => signPayload(id, DOMAIN.entry, entrySigBytes(a, ct));
export const verifyEntrySig = (pub: Uint8Array, a: EntryAAD, ct: Uint8Array, sig: Uint8Array) => verifyPayload(pub, DOMAIN.entry, entrySigBytes(a, ct), sig);
export const signGrant = (id: Identity, a: GrantAAD, wrapped: Uint8Array) => signPayload(id, DOMAIN.grant, grantSigBytes(a, wrapped));

// --- Sealed boxes ----------------------------------------------------------------

const isAllZero = (b: Uint8Array) => b.every((x) => x === 0);

function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array) {
    return hkdf(sha256, shared, concatBytes(ephPub, recipientPub), utf8ToBytes(DOMAIN.seal), KEY_LEN);
}

// HPKE-style sealed box binding AAD: ephPub(32) || XChaCha20-Poly1305 ciphertext
// under an all-zero nonce, safe because every seal uses a fresh ephemeral key.
export function sealTo(recipientEncPub: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
    const ephPriv = x25519.utils.randomSecretKey();
    const ephPub = x25519.getPublicKey(ephPriv);
    const shared = x25519.getSharedSecret(ephPriv, recipientEncPub);
    if (isAllZero(shared)) throw new Error('degenerate shared secret');
    const key = sealKey(shared, ephPub, recipientEncPub);
    return concatBytes(ephPub, xchacha20poly1305(key, new Uint8Array(NONCE_LEN), aad).encrypt(plaintext));
}

export function openSealed(recipientEncPriv: Uint8Array, wire: Uint8Array, aad: Uint8Array): Uint8Array {
    if (wire.length < KEY_LEN) throw new Error('sealed wire too short');
    const ephPub = wire.subarray(0, KEY_LEN);
    const shared = x25519.getSharedSecret(recipientEncPriv, ephPub);
    if (isAllZero(shared)) throw new Error('degenerate shared secret');
    const key = sealKey(shared, ephPub, x25519.getPublicKey(recipientEncPriv));
    return xchacha20poly1305(key, new Uint8Array(NONCE_LEN), aad).decrypt(wire.subarray(KEY_LEN));
}

// --- Epochs ------------------------------------------------------------------------

export type EpochAnnouncement = { audienceId: string; epoch: number; epochPub: Uint8Array; prevHash: string };

export const epochCanonical = (e: EpochAnnouncement) =>
    json([['audience_id', e.audienceId], ['epoch', e.epoch], ['epoch_pubkey', toBase64(e.epochPub)], ['prev_epoch', e.prevHash]]);

export const epochHash = (e: EpochAnnouncement) => bytesToHex(sha256(epochCanonical(e)));

export const signAnnouncement = (admin: Identity, e: EpochAnnouncement) => signPayload(admin, DOMAIN.epoch, epochCanonical(e));

// The fork and rollback detector: contiguous epochs from 1, each linked to its
// predecessor's hash and signed by its (pin-verified) admin.
export function verifyChain(anns: EpochAnnouncement[], sigs: Uint8Array[], adminSigPubs: Uint8Array[]) {
    if (anns.length === 0) throw new Error('empty epoch chain');
    let prev = '';
    anns.forEach((ann, i) => {
        if (ann.epoch !== i + 1) throw new Error(`epoch ${ann.epoch}: non-contiguous or non-monotonic`);
        if (ann.prevHash !== prev) throw new Error(`epoch ${ann.epoch}: prev_epoch chain break (fork or rollback)`);
        if (!verifyPayload(adminSigPubs[i], DOMAIN.epoch, epochCanonical(ann), sigs[i])) throw new Error(`epoch ${ann.epoch}: bad admin signature`);
        prev = epochHash(ann);
    });
}

export const wrapEpochKeyToMember = (memberEncPub: Uint8Array, epochPriv: Uint8Array, a: EpochKeyAAD) => sealTo(memberEncPub, epochPriv, epochKeyAADBytes(a));
export const unwrapEpochKey = (memberEncPriv: Uint8Array, wire: Uint8Array, a: EpochKeyAAD) => openSealed(memberEncPriv, wire, epochKeyAADBytes(a));
export const wrapDEKToEpoch = (epochPub: Uint8Array, dek: Uint8Array, a: GrantAAD) => sealTo(epochPub, dek, grantAADBytes(a));
export const unwrapDEKFromEpoch = (epochPriv: Uint8Array, wire: Uint8Array, a: GrantAAD) => openSealed(epochPriv, wire, grantAADBytes(a));
export const wrapFilterToEpoch = (epochPub: Uint8Array, filter: Uint8Array, a: FilterAAD) => sealTo(epochPub, filter, filterAADBytes(a));
export const unwrapFilterFromEpoch = (epochPriv: Uint8Array, wire: Uint8Array, a: FilterAAD) => openSealed(epochPriv, wire, filterAADBytes(a));
export const wrapNameToEpoch = (epochPub: Uint8Array, name: Uint8Array, a: FilterAAD) => sealTo(epochPub, name, nameAADBytes(a));
export const unwrapNameFromEpoch = (epochPriv: Uint8Array, wire: Uint8Array, a: FilterAAD) => openSealed(epochPriv, wire, nameAADBytes(a));

export const generateEpochKey = () => x25519.utils.randomSecretKey();
export const epochPublicKey = (priv: Uint8Array) => x25519.getPublicKey(priv);

// --- Identity and pin-store wraps -------------------------------------------------

const identityAAD = (userId: string) => json([['user_id', userId]]);
const pinsAAD = (userId: string) => json([['user_id', userId], ['kind', 'pins']]);

export function wrapIdentity(id: Identity, kek: Uint8Array, userId: string) {
    const blob = utf8ToBytes(`{${goString('enc_priv')}:${goString(toBase64(id.encPriv))},${goString('sig_priv')}:${goString(toBase64(goSigPriv(id)))}}`);
    return seal(kek, blob, identityAAD(userId));
}

export function unwrapIdentity(kek: Uint8Array, userId: string, ciphertextB64: string, nonceB64: string): Identity {
    const blob = open(kek, fromBase64(ciphertextB64), fromBase64(nonceB64), identityAAD(userId));
    const w = JSON.parse(bytesToUtf8(blob)) as { enc_priv: string; sig_priv: string };
    const sig = fromBase64(w.sig_priv);
    if (sig.length !== 64) throw new Error('sig private key wrong size');
    return { encPriv: fromBase64(w.enc_priv), sigSeed: sig.slice(0, 32) };
}

export function wrapPins(blob: Uint8Array, dek: Uint8Array, userId: string) {
    return seal(dek, blob, pinsAAD(userId));
}

export function unwrapPins(dek: Uint8Array, userId: string, ciphertextB64: string, nonceB64: string) {
    return open(dek, fromBase64(ciphertextB64), fromBase64(nonceB64), pinsAAD(userId));
}

// The email discovery handle: hex SHA-256 of the trimmed, lowercased address.
export function emailHash(email: string) {
    const e = email.trim().toLowerCase();
    return e ? bytesToHex(sha256(utf8ToBytes(e))) : '';
}

export const randomHexId = () => bytesToHex(randomBytes(16));
export { KEY_LEN };
