// Neon Auth (Better Auth) client, mirroring internal/integrations/neonauth.
// The password sent here is always the derived auth hash, never the real one.
import { AUTH_URL } from './config';

export type User = { id: string; email: string; name: string; image?: string };
export type Session = { token: string; cookie: string; user: User };

export class AuthError extends Error {
    constructor(
        message: string,
        readonly code = '',
    ) {
        super(message);
    }
}

// Better Auth checks Origin against its trusted origins, and a request's own
// origin is trusted by default.
const origin = () => new URL(AUTH_URL).origin;

async function post(path: string, body: unknown, cookie = '') {
    if (!AUTH_URL) throw new AuthError('Sign-in is not configured in this build.');
    const res = await fetch(AUTH_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin(), ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
        credentials: 'omit',
    });
    if (!res.ok) throw await authError(res);
    return res;
}

async function authError(res: Response) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    return new AuthError(body.message || `Sign-in failed (${res.status})`, body.code ?? '');
}

export function isEmailNotVerified(e: unknown) {
    return e instanceof AuthError && (e.code.toUpperCase() === 'EMAIL_NOT_VERIFIED' || /email not verified/i.test(e.message));
}

// The signed session cookie is what /token accepts; the bearer token is not.
function sessionCookie(res: Response): string {
    const header = res.headers.get('set-cookie') ?? '';
    const match = header.match(/(?:^|[,\s])([^=,;\s]*session_token=[^;]+)/);
    return match ? match[1] : '';
}

export async function signInEmail(email: string, authHash: string): Promise<Session> {
    const res = await post('/sign-in/email', { email, password: authHash });
    const body = (await res.json()) as { token?: string; user: User };
    const token = res.headers.get('set-auth-token') || body.token || '';
    if (!token) throw new AuthError('Sign-in returned no session.');
    const cookie = sessionCookie(res);
    if (!cookie) throw new AuthError('Sign-in returned no session cookie.');
    return { token, cookie, user: body.user };
}

// Creates the account. With email verification on, the response carries no
// session yet (null here): the code emailed with it is the next step.
export async function signUpEmail(email: string, authHash: string, name: string): Promise<Session | null> {
    const res = await post('/sign-up/email', { email, password: authHash, name });
    const body = (await res.json()) as { token?: string | null; user: User };
    const token = res.headers.get('set-auth-token') || body.token || '';
    const cookie = sessionCookie(res);
    return token && cookie ? { token, cookie, user: body.user } : null;
}

// Sets the profile picture (a data: URI). /update-user takes the session
// cookie, not the bearer token, and only the image key is sent so the name
// stays as it is.
export async function updateImage(cookie: string, image: string) {
    await post('/update-user', { image }, cookie);
}

export async function sendVerificationOTP(email: string) {
    await post('/email-otp/send-verification-otp', { email, type: 'email-verification' });
}

export async function verifyEmailOTP(email: string, otp: string) {
    await post('/email-otp/verify-email', { email, otp });
}

export async function signOut(token: string) {
    await fetch(AUTH_URL + '/sign-out', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: origin() },
        credentials: 'omit',
    }).catch(() => undefined);
}

// Exchanges the session cookie for a short-lived Data API JWT.
export async function mintJWT(cookie: string): Promise<string> {
    const res = await fetch(AUTH_URL + '/token', { headers: { Cookie: cookie, Origin: origin() }, credentials: 'omit' });
    if (!res.ok) throw await authError(res);
    const { token } = (await res.json()) as { token?: string };
    if (!token) throw new AuthError('Token response contained no JWT.');
    return token;
}

// Reads exp from a JWT without verifying it; only used to decide when to mint
// the next one.
export function jwtExpiry(token: string): number | null {
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const { exp } = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '='))) as { exp?: number };
        return exp ? exp * 1000 : null;
    } catch {
        return null;
    }
}
