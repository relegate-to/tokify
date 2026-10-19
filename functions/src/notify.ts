import { attachDatabasePool } from '@neon/functions';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Pool } from 'pg';

import { FCM, parseServiceAccount } from './fcm';
import { createHandler, MAX_DEVICES } from './handler';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

// Neon Auth JWTs, as the Data API accepts them.
const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL!));
const issuer = new URL(process.env.NEON_AUTH_BASE_URL!).origin;

const fcm = new FCM(parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT ?? ''));

const handle = createHandler({
    async verify(jwt) {
        try {
            const { payload } = await jwtVerify(jwt, jwks, { issuer });
            return payload.sub ?? null;
        } catch {
            return null;
        }
    },
    async devices(userId, except) {
        const { rows } = await pool.query<{ token: string }>(
            'SELECT token FROM public.push_devices WHERE user_id = $1 AND token <> $2 ORDER BY last_seen DESC LIMIT $3',
            [userId, except, MAX_DEVICES],
        );
        return rows.map((r) => r.token);
    },
    async forget(userId, tokens) {
        await pool.query('DELETE FROM public.push_devices WHERE user_id = $1 AND token = ANY($2)', [userId, tokens]);
    },
    send: (token, data) => fcm.send(token, data),
    now: () => new Date(),
});

export default { fetch: handle };
