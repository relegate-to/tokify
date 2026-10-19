// notify: pushes "your running timer changed" to the caller's phones. The
// caller is the device that just started or stopped a timer; the phones read
// running_timers themselves, so the push carries the record's version and a
// timestamp, never anything about the timer (it is end-to-end encrypted).
import type { SendResult } from './fcm';

// Most recently registered first; a user with more phones than this is
// someone filling the table, not a person.
export const MAX_DEVICES = 20;

export type Deps = {
    // The JWT's subject, or null when the token does not verify.
    verify(jwt: string): Promise<string | null>;
    devices(userId: string, except: string): Promise<string[]>;
    forget(userId: string, tokens: string[]): Promise<void>;
    send(token: string, data: Record<string, string>): Promise<SendResult>;
    now(): Date;
};

type Body = { version?: unknown; except?: unknown };

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createHandler(deps: Deps) {
    return async function handle(request: Request): Promise<Response> {
        if (request.method !== 'POST') return json(405, { error: 'POST only' });

        const auth = request.headers.get('authorization') ?? '';
        const userId = auth.toLowerCase().startsWith('bearer ') ? await deps.verify(auth.slice(7).trim()) : null;
        if (!userId) return json(401, { error: 'unauthorized' });

        const body = (await request.json().catch(() => null)) as Body | null;
        const version = body?.version;
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
            return json(400, { error: 'version must be a positive integer' });
        }
        const except = typeof body?.except === 'string' ? body.except : '';

        const tokens = await deps.devices(userId, except);
        const data = { type: 'timer', version: String(version), at: deps.now().toISOString() };
        const results = await Promise.all(tokens.map((t) => deps.send(t, data).catch((): SendResult => 'failed')));
        const gone = tokens.filter((_, i) => results[i] === 'gone');
        if (gone.length > 0) await deps.forget(userId, gone);
        return json(200, { sent: results.filter((r) => r === 'sent').length, removed: gone.length });
    };
}
