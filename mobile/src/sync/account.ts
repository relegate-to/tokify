// The signed-in account: the Neon Auth session, the Data API token minted from
// it, and the account DEK unlocked with the password. Mirrors the desktop's
// AuthSignIn → unlockSync path (cmd/tock-desktop/app.go, neonsync.Unlock).
import * as SecureStore from 'expo-secure-store';
import { randomBytes } from '@noble/hashes/utils.js';

import { argon2id } from '@/crypto/argon2';
import { fromBase64, toBase64 } from '@/crypto/bytes';
import { deriveAuthHash, deriveKEK, seal, unwrapDEK } from '@/crypto/sync';

import { isEmailNotVerified, jwtExpiry, mintJWT, sendVerificationOTP, signInEmail, signOut as revoke, type Session, type User, verifyEmailOTP } from './auth';
import { getUserKeys, insertUserKeys } from './data';
import { clearIdentity, provisionIdentity } from './identity';
import { getSharingKeys } from './sharing-api';
import { clearSharingState } from './sharing-store';

// Separate slots: some platforms warn on secure-store values over 2 KB.
const KEYS = { token: 'session.token', cookie: 'session.cookie', user: 'session.user', dek: 'sync.dek', timer: 'timer.state', pending: 'entries.pending' } as const;

export type Account = { user: User; dek: Uint8Array };

export type SignInResult = { kind: 'signed-in'; account: Account } | { kind: 'verify-email'; email: string };

export async function loadAccount(): Promise<Account | null> {
    const [user, dek] = await Promise.all([SecureStore.getItemAsync(KEYS.user), SecureStore.getItemAsync(KEYS.dek)]);
    if (!user || !dek) return null;
    return { user: JSON.parse(user) as User, dek: fromBase64(dek) };
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
    email = email.trim();
    const authHash = await deriveAuthHash(argon2id, email, password);
    let session: Session;
    try {
        session = await signInEmail(email, authHash);
    } catch (e) {
        if (!isEmailNotVerified(e)) throw e;
        // An account whose sign-up code was never used: send a fresh one and
        // continue at the verification step, as the desktop does.
        await sendVerificationOTP(email).catch(() => undefined);
        return { kind: 'verify-email', email };
    }
    await saveSession(session);
    try {
        const { dek, kek } = await unlock(password, session.user.id);
        await SecureStore.setItemAsync(KEYS.dek, toBase64(dek));
        // Sharing is best-effort at sign-in; Teams offers to unlock it later.
        await provisionIdentity(await dataToken(), kek, session.user.id, session.user).catch(() => undefined);
        return { kind: 'signed-in', account: { user: session.user, dek } };
    } catch (e) {
        await clear();
        throw e;
    }
}

export async function verifyEmail(email: string, password: string, code: string): Promise<SignInResult> {
    await verifyEmailOTP(email.trim(), code.trim());
    return signIn(email, password);
}

export async function resendCode(email: string) {
    await sendVerificationOTP(email.trim());
}

export async function signOut() {
    const token = await SecureStore.getItemAsync(KEYS.token);
    if (token) await revoke(token);
    await clear();
}

// For a session signed in before this phone held a sharing identity: the
// password is needed once more, since only its KEK can unwrap the identity.
export async function unlockSharing(account: Account, password: string) {
    const token = await dataToken();
    const row = await getSharingKeys(token);
    if (!row) throw new Error('This account has no encryption keys yet.');
    const kek = await deriveKEK(argon2id, password, fromBase64(row.salt_enc));
    // Proven against the DEK's wrap first: a wrong password must never get as
    // far as minting an identity under the wrong key.
    try {
        unwrapDEK(kek, row.wrapped_dek, row.wrap_nonce);
    } catch {
        throw new Error('Wrong password.');
    }
    return provisionIdentity(token, kek, account.user.id, account.user, row);
}

let cached: { token: string; cookie: string; expires: number } | null = null;
let minting: Promise<string> | null = null;

// The current Data API JWT, minted from the session cookie and reused until a
// minute before it expires. Concurrent callers share one mint.
export async function dataToken(): Promise<string> {
    const cookie = await SecureStore.getItemAsync(KEYS.cookie);
    if (!cookie) throw new Error('Signed out');
    if (cached && cached.cookie === cookie && Date.now() < cached.expires) return cached.token;
    minting ??= mintJWT(cookie)
        .then((token) => {
            cached = { token, cookie, expires: (jwtExpiry(token) ?? Date.now() + 5 * 60_000) - 60_000 };
            return token;
        })
        .finally(() => {
            minting = null;
        });
    return minting;
}

// Recovers the DEK with the password, or provisions one for an account that
// has never synced.
async function unlock(password: string, userId: string): Promise<{ dek: Uint8Array; kek: Uint8Array }> {
    const token = await dataToken();
    const row = await getUserKeys(token);
    if (row) {
        const kek = await deriveKEK(argon2id, password, fromBase64(row.salt_enc));
        try {
            return { dek: unwrapDEK(kek, row.wrapped_dek, row.wrap_nonce), kek };
        } catch {
            throw new Error('Wrong password for encrypted sync.');
        }
    }
    const salt = randomBytes(16);
    const dek = randomBytes(32);
    const kek = await deriveKEK(argon2id, password, salt);
    const { ciphertext, nonce } = seal(kek, dek);
    await insertUserKeys(token, { user_id: userId, salt_enc: toBase64(salt), wrapped_dek: toBase64(ciphertext), wrap_nonce: toBase64(nonce) });
    return { dek, kek };
}

async function saveSession(s: Session) {
    await Promise.all([
        SecureStore.setItemAsync(KEYS.token, s.token),
        SecureStore.setItemAsync(KEYS.cookie, s.cookie),
        SecureStore.setItemAsync(KEYS.user, JSON.stringify(s.user)),
    ]);
}

async function clear() {
    cached = null;
    await Promise.all([...Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)), clearIdentity(), clearSharingState()]);
}
