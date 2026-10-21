// The account's sketchpad record (internal/integrations/neonsync/sketchpad.go,
// the sketchpads table): one row per user, sealed under the DEK with the owner
// and version in the AAD, written with the running timer's compare-and-swap.
// The reconcile mirrors internal/app/sketchpad's Pad.Sync.
import { bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from '@/crypto/bytes';
import { open, seal } from '@/crypto/sync';

import { DataError, dataFetch } from './data';
import { mergeSketchpad } from './sketchpad-merge';

export type PadState = { version: number; owner: string; html: string };

// What this phone last agreed with the record on.
export type Agreed = { owner: string; version: number; html: string };

export type PadApi = {
    read(): Promise<PadState>;
    // Writes html over version seen; on a lost race, throws PadConflict.
    write(seen: number, html: string): Promise<PadState>;
};

export class PadConflict extends Error {
    constructor(readonly fresh: PadState) {
        super('The sketchpad changed on another device.');
    }
}

const aad = (owner: string, version: number) => utf8ToBytes(`tokify/sketchpad/v1\0${owner}\0${version}`);

type Row = { user_id: string; version: number; ciphertext: string; nonce: string };

const isMissingTable = (e: unknown) => e instanceof DataError && ['PGRST205', '42P01'].includes(e.code);

export function padApi(token: () => Promise<string>, dek: Uint8Array, owner: string): PadApi {
    const read = async (): Promise<PadState> => {
        let rows: Row[];
        try {
            rows = (await dataFetch(await token(), '/sketchpads?select=*')) as Row[];
        } catch (e) {
            if (isMissingTable(e)) return { version: 0, owner: '', html: '' };
            throw e;
        }
        const row = rows[0];
        if (!row) return { version: 0, owner: '', html: '' };
        const plain = open(dek, fromBase64(row.ciphertext), fromBase64(row.nonce), aad(row.user_id, row.version));
        return { version: row.version, owner: row.user_id, html: (JSON.parse(bytesToUtf8(plain)) as { h: string }).h };
    };
    return {
        read,
        async write(seen, html) {
            const version = seen + 1;
            const sealed = seal(dek, utf8ToBytes(JSON.stringify({ h: html })), aad(owner, version));
            const row: Row = { user_id: owner, version, ciphertext: toBase64(sealed.ciphertext), nonce: toBase64(sealed.nonce) };
            let won: boolean;
            if (seen === 0) {
                try {
                    await dataFetch(await token(), '/sketchpads', { method: 'POST', body: JSON.stringify(row), prefer: 'return=minimal' });
                    won = true;
                } catch (e) {
                    if (!(e instanceof DataError && (e.status === 409 || e.code === '23505'))) throw e;
                    won = false;
                }
            } else {
                const written = (await dataFetch(await token(), `/sketchpads?version=eq.${seen}`, {
                    method: 'PATCH',
                    body: JSON.stringify(row),
                    prefer: 'return=representation',
                })) as Row[];
                won = written.length > 0;
            }
            if (!won) throw new PadConflict(await read());
            return { version, owner, html };
        },
    };
}

// Brings local in line with the record. Returns the record as agreed, or null
// when it lost the race three times and the next sync should try again.
export async function reconcilePad(api: PadApi, local: string, agreed: Agreed): Promise<PadState | null> {
    let remote = await api.read();
    for (let attempt = 0; attempt < 3; attempt++) {
        // A record behind the one agreed with, or another account's, shares no
        // history with this pad: merge as if from empty so neither is lost.
        const fromScratch = remote.owner !== agreed.owner || remote.version < agreed.version;
        if (!fromScratch && remote.version === agreed.version && local === agreed.html) return remote;
        const next = mergeSketchpad(fromScratch ? '' : agreed.html, local, remote.html);
        if (next === remote.html && remote.version > 0) return remote;
        try {
            return await api.write(remote.version, next);
        } catch (e) {
            if (!(e instanceof PadConflict)) throw e;
            remote = e.fresh;
        }
    }
    return null;
}
