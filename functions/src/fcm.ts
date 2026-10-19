// FCM HTTP v1 with node:crypto and fetch: a service-account JWT is exchanged
// for an access token, cached per isolate until shortly before it expires.
import { sign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REFRESH_EARLY_MS = 5 * 60_000;

export type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };

// What a send did with one token. 'gone' means FCM no longer knows the token
// (the app was uninstalled or its token rotated), so it should be forgotten.
export type SendResult = 'sent' | 'gone' | 'failed';

export function parseServiceAccount(base64: string): ServiceAccount {
    const sa = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as ServiceAccount;
    if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('FCM service account is missing fields');
    return sa;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

export function serviceAccountJWT(sa: ServiceAccount, now = Date.now()): string {
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
        JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }),
    );
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key);
    return `${header}.${claims}.${b64url(signature)}`;
}

export class FCM {
    private cached: { token: string; expires: number } | null = null;
    private exchanging: Promise<string> | null = null;

    constructor(
        private readonly sa: ServiceAccount,
        private readonly fetchFn: typeof fetch = fetch,
        private readonly now: () => number = Date.now,
    ) {}

    private async accessToken(): Promise<string> {
        if (this.cached && this.now() < this.cached.expires) return this.cached.token;
        this.exchanging ??= this.exchange().finally(() => {
            this.exchanging = null;
        });
        return this.exchanging;
    }

    private async exchange(): Promise<string> {
        const res = await this.fetchFn(this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: serviceAccountJWT(this.sa, this.now()),
            }),
        });
        if (!res.ok) throw new Error(`FCM token exchange failed (${res.status})`);
        const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
        this.cached = { token: access_token, expires: this.now() + expires_in * 1000 - REFRESH_EARLY_MS };
        return access_token;
    }

    // Sends a data-only message: nothing is shown, the app decides what to do
    // with it. Values must be strings.
    async send(token: string, data: Record<string, string>): Promise<SendResult> {
        const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { token, data, android: { priority: 'high', collapse_key: 'timer', ttl: '600s' } } }),
        });
        if (res.ok) return 'sent';
        if (res.status === 401) this.cached = null;
        const body = (await res.json().catch(() => ({}))) as { error?: { details?: { errorCode?: string }[] } };
        if (body.error?.details?.some((d) => d.errorCode === 'UNREGISTERED')) return 'gone';
        console.error(`[notify] FCM send failed (${res.status})`, JSON.stringify(body.error ?? {}));
        return 'failed';
    }
}
