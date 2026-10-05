// The sharing identity: provisioned or unwrapped with the password-derived KEK
// (the only moment that key exists, as in neonsync.provisionIdentity), then
// kept in the secure store for the session.
import * as SecureStore from 'expo-secure-store';

import { fromBase64, toBase64 } from '@/crypto/bytes';
import { emailHash, generateIdentity, publicIdentity, unwrapIdentity, wrapIdentity, type Identity } from '@/crypto/sharing';

import { getSharingKeys, patchIdentityColumns, upsertIdentity, type SharingKeysRow } from './sharing-api';

const ENC = 'sharing.enc';
const SIG = 'sharing.sig';

let cached: Identity | null | undefined;

export async function loadIdentity(): Promise<Identity | null> {
    if (cached !== undefined) return cached;
    const [enc, sig] = await Promise.all([SecureStore.getItemAsync(ENC), SecureStore.getItemAsync(SIG)]);
    cached = enc && sig ? { encPriv: fromBase64(enc), sigSeed: fromBase64(sig) } : null;
    return cached;
}

async function saveIdentity(id: Identity) {
    await Promise.all([SecureStore.setItemAsync(ENC, toBase64(id.encPriv)), SecureStore.setItemAsync(SIG, toBase64(id.sigSeed))]);
    cached = id;
}

export async function clearIdentity() {
    cached = null;
    await Promise.all([SecureStore.deleteItemAsync(ENC), SecureStore.deleteItemAsync(SIG)]);
}

export type Profile = { email: string; name?: string; image?: string };

// Unwraps the account's identity, or mints and publishes one if it has none.
// Re-publishing an existing identity backfills the email discovery hash and the
// profile, best-effort.
export async function provisionIdentity(token: string, kek: Uint8Array, userId: string, profile: Profile, row?: SharingKeysRow | null) {
    row ??= await getSharingKeys(token);
    if (row?.wrapped_identity && row.identity_nonce) {
        const id = unwrapIdentity(kek, userId, row.wrapped_identity, row.identity_nonce);
        await publish(token, userId, id, profile).catch(() => undefined);
        await saveIdentity(id);
        return id;
    }
    const id = generateIdentity();
    const { ciphertext, nonce } = wrapIdentity(id, kek, userId);
    await patchIdentityColumns(token, toBase64(ciphertext), toBase64(nonce));
    await publish(token, userId, id, profile);
    await saveIdentity(id);
    return id;
}

// The public halves, discovery hash and self-chosen profile on identities, so
// teammates can wrap to this account and name it.
export async function publish(token: string, userId: string, id: Identity, profile: Profile) {
    const pub = publicIdentity(id);
    await upsertIdentity(token, {
        user_id: userId,
        pub_enc: toBase64(pub.encPub),
        pub_sig: toBase64(pub.sigPub),
        ...(emailHash(profile.email) ? { email_hash: emailHash(profile.email) } : {}),
        ...(profile.name?.trim() ? { display_name: profile.name.trim() } : {}),
        ...(profile.name?.trim() || profile.image ? { image_url: profile.image?.trim() ?? '' } : {}),
    });
}
