// The sharing tables over the Data API, mirroring
// internal/integrations/neonsync/sharing_client.go. Rows are untrusted
// transport: callers verify signatures and pins before trusting any of them.
import { DataError, dataFetch } from './data';

export const isUniqueViolation = (e: unknown) => e instanceof DataError && (e.code === '23505' || e.status === 409);
const isUnknownColumn = (e: unknown) => e instanceof DataError && (e.code === 'PGRST204' || e.code === '42703');

export type IdentityRow = {
    user_id: string;
    pub_enc: string;
    pub_sig: string;
    email_hash?: string;
    display_name?: string;
    image_url?: string | null;
};
export type AudienceRow = { id: string; created_by: string; current_epoch?: number };
export type EpochRow = { audience_id: string; epoch: number; epoch_pubkey: string; prev_epoch: string; admin_id: string; admin_sig: string };
export type MemberRow = { audience_id: string; member_id: string; role: string; status?: string };
export type EpochKeyRow = { audience_id: string; epoch: number; member_id: string; wrapped_epoch_privkey: string };
export type GrantRow = {
    entry_id: string;
    audience_id: string;
    epoch: number;
    author_id: string;
    wrapped_dek: string;
    author_sig: string;
    valid_from?: string;
    valid_until?: string | null;
    revoked?: boolean;
};
export type ShareRow = { id: string; audience_id: string; epoch: number; filter_ciphertext: string; created_by: string };
export type NameRow = { audience_id: string; epoch: number; name_ciphertext: string; created_by: string };
export type SharedEntryRow = {
    id: string;
    user_id: string;
    ciphertext: string;
    nonce: string;
    version: number;
    author_sig: string;
    contribution_status?: string;
    deleted?: boolean;
};
export type LinkShareRow = { audience_id: string };

const q = encodeURIComponent;
const BATCH = 100;
const get = <T>(token: string, path: string) => dataFetch(token, path) as Promise<T>;
const post = (token: string, path: string, body: unknown, prefer = 'return=minimal') =>
    dataFetch(token, path, { method: 'POST', body: JSON.stringify(body), prefer });
const patch = (token: string, path: string, body: unknown) => dataFetch(token, path, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=minimal' });
const del = (token: string, path: string) => dataFetch(token, path, { method: 'DELETE', prefer: 'return=minimal' });

async function batched<T>(ids: string[], fetchBatch: (inList: string) => Promise<T[]>) {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += BATCH) out.push(...(await fetchBatch(ids.slice(i, i + BATCH).map(q).join(','))));
    return out;
}

// --- Identities and user_keys ---------------------------------------------------

export async function getIdentities(token: string, userIds: string[]): Promise<Map<string, IdentityRow>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const rows = await batched(unique, (list) => get<IdentityRow[]>(token, `/identities?select=*&user_id=in.(${list})`));
    return new Map(rows.map((r) => [r.user_id, r]));
}

export async function getIdentity(token: string, userId: string): Promise<IdentityRow | null> {
    return (await get<IdentityRow[]>(token, `/identities?select=*&user_id=eq.${q(userId)}`))[0] ?? null;
}

export const getIdentitiesByEmailHash = (token: string, hash: string) => get<IdentityRow[]>(token, `/identities?select=*&email_hash=eq.${q(hash)}`);

// An upsert that never clears a field it doesn't carry: absent keys are left
// out. A server without image_url yet refuses the whole row, so retry without
// the avatar rather than lose the display name with it.
export async function upsertIdentity(token: string, row: IdentityRow) {
    const write = (r: IdentityRow) => post(token, '/identities', r, 'resolution=merge-duplicates,return=minimal');
    try {
        await write(row);
    } catch (e) {
        if (row.image_url === undefined || !isUnknownColumn(e)) throw e;
        const { image_url: _, ...rest } = row;
        await write(rest);
    }
}

export const patchIdentityColumns = (token: string, wrappedIdentity: string, identityNonce: string) =>
    patch(token, '/user_keys', { wrapped_identity: wrappedIdentity, identity_nonce: identityNonce });

export const patchPinsColumns = (token: string, wrappedPins: string, pinsNonce: string) =>
    patch(token, '/user_keys', { wrapped_pins: wrappedPins, pins_nonce: pinsNonce });

export type SharingKeysRow = {
    salt_enc: string;
    wrapped_dek: string;
    wrap_nonce: string;
    wrapped_identity?: string | null;
    identity_nonce?: string | null;
    wrapped_pins?: string | null;
    pins_nonce?: string | null;
};

export async function getSharingKeys(token: string): Promise<SharingKeysRow | null> {
    return (await get<SharingKeysRow[]>(token, '/user_keys?select=salt_enc,wrapped_dek,wrap_nonce,wrapped_identity,identity_nonce,wrapped_pins,pins_nonce'))[0] ?? null;
}

// --- Audiences, epochs, members ---------------------------------------------------

export const getAudiences = (token: string) => get<AudienceRow[]>(token, '/audiences?select=*');
export const insertAudience = (token: string, row: AudienceRow) => post(token, '/audiences', row);
export const deleteAudience = (token: string, id: string) => del(token, `/audiences?id=eq.${q(id)}`);
export const getLinkShares = (token: string) => get<LinkShareRow[]>(token, '/link_shares?select=audience_id');

export const getEpochs = (token: string, audienceId: string) =>
    get<EpochRow[]>(token, `/audience_epochs?select=*&audience_id=eq.${q(audienceId)}&order=epoch.asc`);
export const insertEpoch = (token: string, row: EpochRow) => post(token, '/audience_epochs', row);

// The caller's own invitations still waiting to be accepted; RLS shows an
// invitee their own row, so this needs no sharing identity.
export const getMyInvites = (token: string, userId: string) =>
    get<{ audience_id: string }[]>(token, `/audience_members?select=audience_id&member_id=eq.${q(userId)}&status=eq.invited`);

export const getMembers = (token: string, audienceId: string) => get<MemberRow[]>(token, `/audience_members?select=*&audience_id=eq.${q(audienceId)}`);

export async function getMembersByAudiences(token: string, audienceIds: string[]): Promise<Map<string, MemberRow[]>> {
    const rows = await batched(audienceIds, (list) => get<MemberRow[]>(token, `/audience_members?select=*&audience_id=in.(${list})`));
    const out = new Map<string, MemberRow[]>();
    for (const r of rows) out.set(r.audience_id, [...(out.get(r.audience_id) ?? []), r]);
    return out;
}

// A plain insert (ON CONFLICT would fail the creator's own bootstrap row); a
// duplicate means the member is already there, which keeps re-invites idempotent.
export async function insertMember(token: string, row: MemberRow) {
    try {
        await post(token, '/audience_members', row);
    } catch (e) {
        if (!isUniqueViolation(e)) throw e;
    }
}
export const deleteMember = (token: string, audienceId: string, memberId: string) =>
    del(token, `/audience_members?audience_id=eq.${q(audienceId)}&member_id=eq.${q(memberId)}`);
export const updateMemberStatus = (token: string, audienceId: string, memberId: string, status: string) =>
    patch(token, `/audience_members?audience_id=eq.${q(audienceId)}&member_id=eq.${q(memberId)}`, { status });

export const getMyEpochKeys = (token: string, audienceId: string) => get<EpochKeyRow[]>(token, `/audience_epoch_keys?select=*&audience_id=eq.${q(audienceId)}`);

// A plain insert: ON CONFLICT would pull the SELECT policy in as a WITH CHECK
// and reject wraps to other members, so stale wraps are deleted first.
// A surviving wrap of the same epoch already decrypts to the same key, so on a
// duplicate the rows go in one by one with duplicates skipped.
export async function insertEpochKeys(token: string, rows: EpochKeyRow[]) {
    if (!rows.length) return;
    try {
        await post(token, '/audience_epoch_keys', rows);
    } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        for (const row of rows) {
            await post(token, '/audience_epoch_keys', [row]).catch((err: unknown) => {
                if (!isUniqueViolation(err)) throw err;
            });
        }
    }
}
export async function deleteEpochKeys(token: string, audienceId: string, epoch: number, memberIds: string[]) {
    for (let i = 0; i < memberIds.length; i += BATCH) {
        const list = memberIds.slice(i, i + BATCH).map(q).join(',');
        await del(token, `/audience_epoch_keys?audience_id=eq.${q(audienceId)}&epoch=eq.${epoch}&member_id=in.(${list})`);
    }
}

// --- Grants, shares, names ------------------------------------------------------------

export const getGrantsForAudience = (token: string, audienceId: string) => get<GrantRow[]>(token, `/entry_audience_grants?select=*&audience_id=eq.${q(audienceId)}`);
export const getMyGrantsForAudience = (token: string, audienceId: string, authorId: string) =>
    get<GrantRow[]>(token, `/entry_audience_grants?select=*&audience_id=eq.${q(audienceId)}&author_id=eq.${q(authorId)}`);
export const insertGrants = (token: string, rows: GrantRow[]) => (rows.length ? post(token, '/entry_audience_grants', rows) : Promise.resolve());
export const deleteGrant = (token: string, entryId: string, audienceId: string) =>
    del(token, `/entry_audience_grants?entry_id=eq.${q(entryId)}&audience_id=eq.${q(audienceId)}`);

export const getShares = (token: string, audienceId: string) => get<ShareRow[]>(token, `/shares?select=*&audience_id=eq.${q(audienceId)}`);
export const upsertShare = (token: string, row: ShareRow) => post(token, '/shares', row, 'resolution=merge-duplicates,return=minimal');

export const getAudienceName = (token: string, audienceId: string) => get<NameRow[]>(token, `/audience_names?select=*&audience_id=eq.${q(audienceId)}`);
export const upsertAudienceName = (token: string, row: NameRow) => post(token, '/audience_names', row, 'resolution=merge-duplicates,return=minimal');
export const deleteAudienceName = (token: string, audienceId: string) => del(token, `/audience_names?audience_id=eq.${q(audienceId)}`);

// --- Entries --------------------------------------------------------------------------

export const getEntriesByIds = (token: string, ids: string[]) => batched(ids, (list) => get<SharedEntryRow[]>(token, `/entries?select=*&id=in.(${list})`));

export const upsertSharedEntries = (token: string, rows: SharedEntryRow[]) =>
    rows.length ? post(token, '/entries', rows, 'resolution=merge-duplicates,return=minimal') : Promise.resolve();
