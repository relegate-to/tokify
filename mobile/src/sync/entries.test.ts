import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({}));
let identity: Identity | null = null;
vi.mock('./identity', () => ({ loadIdentity: async () => identity }));
const calls: { path: string; init: { method?: string; body?: string } }[] = [];
vi.mock('./data', () => ({ dataFetch: vi.fn(async (_t: string, path: string, init: { method?: string; body?: string }) => void calls.push({ path, init })) }));

import { fromBase64 } from '@/crypto/bytes';
import { generateIdentity, publicIdentity, verifyEntrySig, type Identity } from '@/crypto/sharing';
import { canonicalize, decryptOwnEntry, entryId } from '@/crypto/sync';

import { editEntry, entryFromTimer, pushEntries, syncTime } from './entries';

describe('entries from the phone', () => {
    it('formats times as the desktop sync format, in local time', () => {
        expect(syncTime(new Date(2026, 9, 3, 9, 5, 59))).toBe('2026-10-03 09:05');
    });

    it('rounds a desktop nanosecond start down to the minute like the desktop', () => {
        const start = new Date(2026, 9, 3, 9, 30, 15, 123);
        const end = new Date(2026, 9, 3, 10, 45, 59);
        const e = entryFromTimer({ d: 'Plan', p: 'tokify', s: start.toISOString().replace('Z', '456Z'), e: end.toISOString(), dev: 'mac' });
        expect(e).toEqual({ description: 'Plan', project: 'tokify', start: '2026-10-03 09:30', end: '2026-10-03 10:45' });
    });
});

describe('editing an entry', () => {
    const dek = new Uint8Array(32).fill(3);
    const old = { description: 'Plan', project: 'tokify', start: '2026-10-03 09:00', end: '2026-10-03 10:00' };
    const oldEntry = { ...old, id: entryId(dek, canonicalize(old)) };

    it('writes the new entry before tombstoning the old one', async () => {
        calls.length = 0;
        await editEntry('t', dek, 'u', oldEntry, { ...old, description: 'Plan the release' });
        expect(calls.map((c) => c.init.method)).toEqual(['POST', 'PATCH']);
        expect(calls[1].path).toBe(`/entries?id=in.(${oldEntry.id})`);
        expect(JSON.parse(calls[1].init.body!)).toEqual({ deleted: true });
    });

    it('does nothing when the content is unchanged', async () => {
        calls.length = 0;
        await editEntry('t', dek, 'u', oldEntry, { ...old });
        expect(calls).toHaveLength(0);
    });
});

describe('pushing with a sharing identity', () => {
    const dek = new Uint8Array(32).fill(5);
    const entry = { description: 'Review', project: 'tokify', start: '2026-10-03 09:00', end: '2026-10-03 09:45' };

    it('writes the signed v2 row teammates can verify', async () => {
        identity = generateIdentity();
        calls.length = 0;
        await pushEntries('t', dek, 'u', [entry]);
        const [row] = JSON.parse(calls[0].init.body!);
        expect(row.id).toBe(entryId(dek, canonicalize(entry)));
        expect(row.version).toBe(1);
        expect(row).not.toHaveProperty('deleted');
        const aad = { entryId: row.id, version: 1, authorId: 'u' };
        expect(verifyEntrySig(publicIdentity(identity).sigPub, aad, fromBase64(row.ciphertext), fromBase64(row.author_sig))).toBe(true);
        expect(decryptOwnEntry(dek, 'u', row)).toEqual(entry);
        identity = null;
    });
});
