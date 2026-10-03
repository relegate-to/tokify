// Completed activities in the encrypted entries table, mirroring the desktop's
// push and pull (internal/integrations/neonsync/service.go).
import * as SecureStore from 'expo-secure-store';

import { toBase64 } from '@/crypto/bytes';
import { canonicalize, decryptOwnEntry, entryId, seal, type CanonicalEntry, type RunningTimer } from '@/crypto/sync';
import { parseInstant } from '@/lib/time';

import { dataFetch } from './data';

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

// Uploads entries in the legacy account-DEK format, which desktops read and
// re-push in the signed v2 format under the same content id. `deleted` is
// left out so an upsert never clears a tombstone set elsewhere.
export async function pushEntries(token: string, dek: Uint8Array, owner: string, entries: CanonicalEntry[]) {
    if (entries.length === 0) return;
    const rows = entries.map((e) => {
        const canon = canonicalize(e);
        const { ciphertext, nonce } = seal(dek, canon);
        return { id: entryId(dek, canon), user_id: owner, ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) };
    });
    await dataFetch(token, '/entries', { method: 'POST', body: JSON.stringify(rows), prefer: 'resolution=merge-duplicates,return=minimal' });
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

export type Entry = CanonicalEntry & { id: string };

// The caller's live entries, newest first. Rows that fail to decrypt are
// skipped rather than failing the list.
export async function listEntries(token: string, dek: Uint8Array, owner: string): Promise<Entry[]> {
    const rows = (await dataFetch(token, `/entries?select=id,ciphertext,nonce&user_id=eq.${encodeURIComponent(owner)}&deleted=eq.false`)) as {
        id: string;
        ciphertext: string;
        nonce: string;
    }[];
    const out: Entry[] = [];
    for (const row of rows) {
        try {
            out.push({ id: row.id, ...decryptOwnEntry(dek, owner, row) });
        } catch {
            // Not decryptable with this account's key; nothing to show.
        }
    }
    return out.sort((a, b) => b.start.localeCompare(a.start));
}
