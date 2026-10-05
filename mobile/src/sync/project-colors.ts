// Project colors shared across the account's devices, as the desktop syncs them
// (internal/integrations/neonsync/project_colors.go): a map of project name to
// color and choice time, sealed under the DEK in user_keys.wrapped_projects.
// Per project the newest choice wins; an empty color is a synced reset.
import { bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from '@/crypto/bytes';
import { goObject } from '@/crypto/gojson';
import { open, seal } from '@/crypto/sync';

import { DataError, dataFetch } from './data';

export type ColorPref = { color: string; at: string };
export type Colors = Record<string, ColorPref>;

const aad = (userId: string) => utf8ToBytes(goObject([['user_id', userId], ['kind', 'projects']]));

const time = (at: string) => {
    const t = Date.parse(at);
    return Number.isNaN(t) ? 0 : t;
};

// Each project's most recent choice; on a tie the first set's wins.
export function mergeColors(a: Colors, b: Colors): Colors {
    const out = { ...a };
    for (const [name, pref] of Object.entries(b)) {
        if (!out[name] || time(pref.at) > time(out[name].at)) out[name] = pref;
    }
    return out;
}

const same = (a: Colors, b: Colors) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k]?.color === v.color && b[k]?.at === v.at);

type KeysRow = { wrapped_projects?: string | null; projects_nonce?: string | null };

const isUnknownColumn = (e: unknown) => e instanceof DataError && (e.code === 'PGRST204' || e.code === '42703');

// Merges this phone's colors with the account's and returns the result,
// writing it back when the server was behind. A server without the column yet
// leaves the phone's colors as they are.
export async function syncColors(token: string, dek: Uint8Array, userId: string, local: Colors): Promise<Colors> {
    const row = ((await dataFetch(token, '/user_keys?select=*')) as KeysRow[])[0];
    let remote: Colors = {};
    if (row?.wrapped_projects && row.projects_nonce) {
        try {
            const plain = open(dek, fromBase64(row.wrapped_projects), fromBase64(row.projects_nonce), aad(userId));
            remote = (JSON.parse(bytesToUtf8(plain)) as { colors?: Colors }).colors ?? {};
        } catch {
            // Unreadable: rewritten from the merge below.
        }
    }
    const merged = mergeColors(remote, local);
    if (same(merged, remote)) return merged;
    const { ciphertext, nonce } = seal(dek, utf8ToBytes(JSON.stringify({ colors: merged })), aad(userId));
    try {
        await dataFetch(token, '/user_keys', {
            method: 'PATCH',
            body: JSON.stringify({ wrapped_projects: toBase64(ciphertext), projects_nonce: toBase64(nonce) }),
            prefer: 'return=minimal',
        });
    } catch (e) {
        if (isUnknownColumn(e)) return local;
        throw e;
    }
    return merged;
}
