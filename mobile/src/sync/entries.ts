// Completed activities in the encrypted entries table, mirroring the desktop's
// push and pull (internal/integrations/neonsync/service.go).
import * as SecureStore from 'expo-secure-store';

import { toBase64 } from '@/crypto/bytes';
import { entryAADBytes, signEntry, type Identity } from '@/crypto/sharing';
import { canonicalize, decryptOwnEntry, deriveEntryDEK, entryId, seal, type CanonicalEntry, type RunningTimer } from '@/crypto/sync';
import { parseInstant } from '@/lib/time';

import { dataFetch } from './data';
import { loadIdentity } from './identity';

const PENDING_KEY = 'entries.pending';

const pad = (n: number) => String(n).padStart(2, '0');

// The sync format's "2006-01-02 15:04" in local time, as the desktop writes it.
// Entry ids hash this string, so it must match the desktop to the minute.
export function syncTime(d: Date) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function entryFromTimer(t: RunningTimer & { e: string }): CanonicalEntry {
    return { description: t.d, project: t.p, start: syncTime(parseInstant(t.s)), end: syncTime(parseInstant(t.e)) };
}

// Uploads entries in the signed v2 format (per-entry DEK, AAD-bound,
// author-signed) once this phone holds a sharing identity, and in the legacy
// account-DEK format until then; desktops re-push those signed under the same
// content id. `deleted` and `contribution_status` are left out so an upsert
// never clears a tombstone or fails the status check.
export async function pushEntries(token: string, dek: Uint8Array, owner: string, entries: CanonicalEntry[]) {
    if (entries.length === 0) return;
    const identity = await loadIdentity();
    const rows = entries.map((e) => {
        const canon = canonicalize(e);
        const id = entryId(dek, canon);
        if (identity) return signedRow(identity, dek, owner, id, canon);
        const { ciphertext, nonce } = seal(dek, canon);
        return { id, user_id: owner, ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) };
    });
    await dataFetch(token, '/entries', { method: 'POST', body: JSON.stringify(rows), prefer: 'resolution=merge-duplicates,return=minimal' });
}

function signedRow(identity: Identity, dek: Uint8Array, owner: string, id: string, canon: Uint8Array) {
    const aad = { entryId: id, version: 1, authorId: owner };
    const { ciphertext, nonce } = seal(deriveEntryDEK(dek, id), canon, entryAADBytes(aad));
    return {
        id,
        user_id: owner,
        ciphertext: toBase64(ciphertext),
        nonce: toBase64(nonce),
        version: 1,
        author_sig: toBase64(signEntry(identity, aad, ciphertext)),
    };
}

// Re-pushes the caller's own entries in the signed format, for sharing.
export async function pushSignedEntries(s: { token: string; dek: Uint8Array; userId: string; id: Identity }, entries: Entry[]) {
    if (entries.length === 0) return;
    const rows = entries.map((e) => signedRow(s.id, s.dek, s.userId, e.id, canonicalize(e)));
    await dataFetch(s.token, '/entries', { method: 'POST', body: JSON.stringify(rows), prefer: 'resolution=merge-duplicates,return=minimal' });
}

// Entries waiting to be pushed survive restarts, so a stop made offline still
// reaches the cloud.
export async function queueEntry(entry: CanonicalEntry) {
    const pending = await readPending();
    pending.push(entry);
    await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(pending));
}

// Reports whether anything was pushed.
export async function flushPending(token: string, dek: Uint8Array, owner: string) {
    const pending = await readPending();
    if (pending.length === 0) return false;
    await pushEntries(token, dek, owner, pending);
    await SecureStore.deleteItemAsync(PENDING_KEY);
    return true;
}

async function readPending(): Promise<CanonicalEntry[]> {
    const raw = await SecureStore.getItemAsync(PENDING_KEY);
    return raw ? (JSON.parse(raw) as CanonicalEntry[]) : [];
}

// signed: the row carries an author signature (the v2 format), so teammates
// can verify it when it's shared.
export type Entry = CanonicalEntry & { id: string; signed?: boolean };

// The caller's live entries, newest first. Rows that fail to decrypt are
// skipped rather than failing the list.
export async function listEntries(token: string, dek: Uint8Array, owner: string): Promise<Entry[]> {
    const rows = (await dataFetch(token, `/entries?select=id,ciphertext,nonce,author_sig&user_id=eq.${encodeURIComponent(owner)}&deleted=eq.false`)) as {
        id: string;
        ciphertext: string;
        nonce: string;
        author_sig?: string | null;
    }[];
    const out: Entry[] = [];
    for (const row of rows) {
        try {
            out.push({ id: row.id, ...decryptOwnEntry(dek, owner, row), signed: Boolean(row.author_sig) });
        } catch {
            // Not decryptable with this account's key; nothing to show.
        }
    }
    return out.sort((a, b) => b.start.localeCompare(a.start));
}

// Deletes by tombstone, as the desktop does: the row stays with deleted=true so
// other devices remove their copy instead of re-uploading it.
// Batched, since a large selection would otherwise overflow the URL.
const DELETE_BATCH = 100;

export async function deleteEntries(token: string, ids: string[]) {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        await dataFetch(token, `/entries?id=in.(${ids.slice(i, i + DELETE_BATCH).join(',')})`, {
            method: 'PATCH',
            body: JSON.stringify({ deleted: true }),
            prefer: 'return=minimal',
        });
    }
}

// An edit changes the content, and so the id: write the new entry, then
// tombstone the old one. The order means a failure part-way leaves a
// duplicate rather than a loss.
export async function editEntry(token: string, dek: Uint8Array, owner: string, old: Entry, next: CanonicalEntry) {
    const nextId = entryId(dek, canonicalize(next));
    if (nextId === old.id) return;
    await pushEntries(token, dek, owner, [next]);
    await deleteEntries(token, [old.id]);
}
