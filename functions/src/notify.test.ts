import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FCM, parseServiceAccount, serviceAccountJWT, type SendResult, type ServiceAccount } from './fcm';
import { createHandler, type Deps } from './handler';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa: ServiceAccount = {
    project_id: 'tokify-test',
    client_email: 'notify@tokify-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const post = (body: unknown, jwt = 'good') =>
    new Request('http://localhost/', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });

function fakeDeps(results: Record<string, SendResult>) {
    const sent: { token: string; data: Record<string, string> }[] = [];
    const forgotten: string[][] = [];
    const deps: Deps = {
        verify: async (jwt) => (jwt === 'good' ? 'alice' : null),
        devices: async (userId, except) => (userId === 'alice' ? Object.keys(results).filter((t) => t !== except) : []),
        forget: async (_, tokens) => void forgotten.push(tokens),
        send: async (token, data) => {
            sent.push({ token, data });
            return results[token];
        },
        now: () => new Date('2026-10-19T09:00:00Z'),
    };
    return { deps, sent, forgotten };
}

describe('notify handler', () => {
    it('refuses callers without a valid JWT', async () => {
        const { deps, sent } = fakeDeps({ a: 'sent' });
        const handle = createHandler(deps);
        expect((await handle(post({ version: 1 }, 'forged'))).status).toBe(401);
        expect((await handle(new Request('http://localhost/', { method: 'POST', body: '{}' }))).status).toBe(401);
        expect(sent).toHaveLength(0);
    });

    it('wants a POST with a positive integer version', async () => {
        const handle = createHandler(fakeDeps({}).deps);
        expect((await handle(new Request('http://localhost/'))).status).toBe(405);
        for (const version of [undefined, 0, -1, 1.5, '3']) expect((await handle(post({ version }))).status).toBe(400);
    });

    it('pushes the version and a timestamp only, skipping the caller', async () => {
        const { deps, sent } = fakeDeps({ a: 'sent', b: 'sent', self: 'sent' });
        const res = await createHandler(deps)(post({ version: 7, except: 'self' }));
        expect(await res.json()).toEqual({ sent: 2, removed: 0 });
        expect(sent.map((s) => s.token)).toEqual(['a', 'b']);
        expect(sent[0].data).toEqual({ type: 'timer', version: '7', at: '2026-10-19T09:00:00.000Z' });
    });

    it('forgets tokens FCM reports as unregistered, keeping the rest', async () => {
        const { deps, forgotten } = fakeDeps({ a: 'gone', b: 'failed', c: 'sent' });
        const res = await createHandler(deps)(post({ version: 2 }));
        expect(await res.json()).toEqual({ sent: 1, removed: 1 });
        expect(forgotten).toEqual([['a']]);
    });
});

describe('FCM', () => {
    it('signs an RS256 service-account JWT for the messaging scope', () => {
        const [header, claims, signature] = serviceAccountJWT(sa, Date.UTC(2026, 9, 19) + 500).split('.');
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
        expect(c).toMatchObject({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/firebase.messaging' });
        expect(c.exp - c.iat).toBe(3600);
        expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    });

    it('reads the base64 service account', () => {
        expect(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString('base64'))).toEqual(sa);
        expect(() => parseServiceAccount(Buffer.from('{}').toString('base64'))).toThrow();
    });

    function fakeGoogle(sendStatus: number, sendBody: unknown = {}) {
        const calls: { url: string; init: RequestInit }[] = [];
        const fetchFn = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            if (url.includes('oauth2')) return Response.json({ access_token: `at${calls.length}`, expires_in: 3600 });
            return Response.json(sendBody, { status: sendStatus });
        }) as typeof fetch;
        return { calls, fetchFn };
    }

    it('exchanges once and reuses the access token until it nears expiry', async () => {
        const { calls, fetchFn } = fakeGoogle(200, { name: 'm' });
        let now = 0;
        const fcm = new FCM(sa, fetchFn, () => now);
        await Promise.all([fcm.send('a', {}), fcm.send('b', {})]);
        now = 50 * 60_000;
        await fcm.send('c', {});
        expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
        now = 56 * 60_000;
        await fcm.send('d', {});
        expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);

        const send = calls.find((c) => c.url.includes('messages:send'))!;
        expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/tokify-test/messages:send');
        expect((send.init.headers as Record<string, string>).Authorization).toBe('Bearer at1');
        expect(JSON.parse(send.init.body as string).message).toMatchObject({ token: 'a', data: {}, android: { priority: 'high' } });
    });

    it('reports UNREGISTERED tokens as gone and other errors as failed', async () => {
        const unregistered = {
            error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
        };
        expect(await new FCM(sa, fakeGoogle(404, unregistered).fetchFn).send('a', {})).toBe('gone');
        const invalid = { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } };
        expect(await new FCM(sa, fakeGoogle(400, invalid).fetchFn).send('a', {})).toBe('failed');
    });
});
