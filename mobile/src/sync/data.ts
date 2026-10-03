// Neon Data API (PostgREST) calls, mirroring internal/integrations/neonsync/client.go.
import { DATA_URL } from './config';

export class DataError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code = '',
    ) {
        super(message);
    }
}

export async function dataFetch(token: string, path: string, init: RequestInit & { prefer?: string } = {}) {
    if (!DATA_URL) throw new DataError('Sync is not configured in this build.', 0);
    const { prefer, ...rest } = init;
    const res = await fetch(DATA_URL + path, {
        ...rest,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
            ...(prefer ? { Prefer: prefer } : {}),
        },
    });
    const text = await res.text();
    if (!res.ok) {
        const body = (() => {
            try {
                return JSON.parse(text) as { message?: string; hint?: string; code?: string };
            } catch {
                return {};
            }
        })();
        throw new DataError(body.message || `Sync request failed (${res.status})`, res.status, body.code ?? '');
    }
    return text ? JSON.parse(text) : null;
}

export type UserKeysRow = { user_id: string; salt_enc: string; wrapped_dek: string; wrap_nonce: string };

export async function getUserKeys(token: string): Promise<UserKeysRow | null> {
    const rows = (await dataFetch(token, '/user_keys?select=user_id,salt_enc,wrapped_dek,wrap_nonce')) as UserKeysRow[];
    return rows[0] ?? null;
}

export async function insertUserKeys(token: string, row: UserKeysRow) {
    await dataFetch(token, '/user_keys', { method: 'POST', body: JSON.stringify(row), prefer: 'return=minimal' });
}
