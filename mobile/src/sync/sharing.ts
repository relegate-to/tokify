// The sharing operations layer, ported from internal/integrations/neonsync
// (sharing_service.go, sharing_teams.go, sharing_read.go,
// sharing_reconcile.go). It owns what RLS cannot: every signature and the epoch
// chain are verified, and every key is pin-checked, before anything is wrapped
// to it or accepted from it.
import { bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from '@/crypto/bytes';
import {
    emailHash,
    entryAADBytes,
    epochHash,
    epochPublicKey,
    fingerprint,
    generateEpochKey,
    publicIdentity,
    randomHexId,
    signAnnouncement,
    signGrant,
    unwrapDEKFromEpoch,
    unwrapEpochKey,
    unwrapFilterFromEpoch,
    unwrapNameFromEpoch,
    unwrapPins,
    verifyChain,
    verifyEntrySig,
    wrapDEKToEpoch,
    wrapEpochKeyToMember,
    wrapFilterToEpoch,
    wrapNameToEpoch,
    wrapPins,
    type EpochAnnouncement,
    type Identity,
    type PublicIdentity,
} from '@/crypto/sharing';
import { deriveEntryDEK, open, parseCanonical } from '@/crypto/sync';
import { parseSyncTime } from '@/lib/time';

import { dataToken, type Account } from './account';
import { DataError } from './data';
import { pushSignedEntries, type Entry } from './entries';
import { loadIdentity, publish } from './identity';
import { checkEpochWatermark, exportPins, isPinned, markJoined, mergePins, parsePins, pin, PinConflict, repin, seedJoined, verifyPin } from './pins';
import * as api from './sharing-api';
import { loadPins, loadSharedCache, loadTeamNames, savePins, saveSharedCache, setTeamNameLocal } from './sharing-store';

export class SharingLocked extends Error {
    constructor() {
        super('Sharing is locked on this phone.');
    }
}
export class NotPinned extends Error {
    constructor(who = 'This person') {
        super(`${who}'s security key isn't verified on this phone.`);
    }
}
export class KeyChanged extends Error {
    constructor() {
        super("Their security key changed since you last saw it, so they weren't added.");
    }
}
export class EmailNotFound extends Error {
    constructor() {
        super("Nobody on Tokify has that email yet, or they haven't turned on sharing.");
    }
}

const isMissingSchema = (e: unknown) => e instanceof DataError && ['PGRST205', '42P01', 'PGRST202', '42883'].includes(e.code);

type Session = { token: string; userId: string; id: Identity; dek: Uint8Array; account: Account };

async function session(account: Account): Promise<Session> {
    const id = await loadIdentity();
    if (!id) throw new SharingLocked();
    return { token: await dataToken(), userId: account.user.id, id, dek: account.dek, account };
}

export const sharingUnlocked = async () => (await loadIdentity()) !== null;

// --- Pins --------------------------------------------------------------------------

async function pushPins(s: Session) {
    try {
        const { ciphertext, nonce } = wrapPins(utf8ToBytes(exportPins(loadPins())), s.dek, s.userId);
        await api.patchPinsColumns(s.token, toBase64(ciphertext), toBase64(nonce));
    } catch {
        // Local pins stay authoritative; the next change or unlock retries.
    }
}

// Converges trust decisions made on the account's other devices.
async function pullPins(s: Session) {
    try {
        const row = await api.getSharingKeys(s.token);
        if (!row?.wrapped_pins || !row.pins_nonce) return;
        savePins(mergePins(loadPins(), parsePins(bytesToUtf8(unwrapPins(s.dek, s.userId, row.wrapped_pins, row.pins_nonce)))));
    } catch {
        // Keep working with the pins this phone already has.
    }
}

function publicFromRow(row: api.IdentityRow): PublicIdentity {
    const sigPub = fromBase64(row.pub_sig);
    if (sigPub.length !== 32) throw new Error('pub_sig wrong size');
    return { encPub: fromBase64(row.pub_enc), sigPub };
}

// A user's published key, refused unless its fingerprint is the pinned one.
async function pinnedIdentity(s: Session, userId: string, cache?: Map<string, PublicIdentity>) {
    const hit = cache?.get(userId);
    if (hit) return hit;
    const row = await api.getIdentity(s.token, userId);
    if (!row) throw new NotPinned();
    const pub = publicFromRow(row);
    if (!verifyPin(loadPins(), userId, fingerprint(pub))) throw new NotPinned(row.display_name || undefined);
    cache?.set(userId, pub);
    return pub;
}

// --- Epochs --------------------------------------------------------------------------

// The full history, checked against the watermark and verified as a chain
// signed by pinned admins. Anything unverifiable stops the audience cold.
async function verifiedEpochs(s: Session, audienceId: string, admins = new Map<string, PublicIdentity>()): Promise<EpochAnnouncement[]> {
    const rows = await api.getEpochs(s.token, audienceId);
    savePins(checkEpochWatermark(loadPins(), audienceId, rows.length));
    if (rows.length === 0) return [];
    const anns: EpochAnnouncement[] = [];
    const sigs: Uint8Array[] = [];
    const adminPubs: Uint8Array[] = [];
    for (const r of rows) {
        anns.push({ audienceId: r.audience_id, epoch: r.epoch, epochPub: fromBase64(r.epoch_pubkey), prevHash: r.prev_epoch });
        sigs.push(fromBase64(r.admin_sig));
        adminPubs.push((await pinnedIdentity(s, r.admin_id, admins)).sigPub);
    }
    verifyChain(anns, sigs, adminPubs);
    return anns;
}

// The epoch private keys wrapped to the caller, fetched once per audience.
function epochKeys(s: Session, audienceId: string) {
    let rows: Promise<api.EpochKeyRow[]> | null = null;
    const unwrapped = new Map<number, Uint8Array>();
    return async (epoch: number) => {
        const hit = unwrapped.get(epoch);
        if (hit) return hit;
        rows ??= api.getMyEpochKeys(s.token, audienceId);
        const row = (await rows).find((k) => k.epoch === epoch && k.member_id === s.userId);
        if (!row) throw new Error(`No key held for this team's epoch ${epoch}.`);
        const key = unwrapEpochKey(s.id.encPriv, fromBase64(row.wrapped_epoch_privkey), { audienceId, epoch, memberId: s.userId });
        unwrapped.set(epoch, key);
        return key;
    };
}

async function publishEpoch(s: Session, audienceId: string, epoch: number, prevHash: string, epochPriv: Uint8Array) {
    const ann = { audienceId, epoch, epochPub: epochPublicKey(epochPriv), prevHash };
    await api.insertEpoch(s.token, {
        audience_id: audienceId,
        epoch,
        epoch_pubkey: toBase64(ann.epochPub),
        prev_epoch: prevHash,
        admin_id: s.userId,
        admin_sig: toBase64(signAnnouncement(s.id, ann)),
    });
}

async function wrapEpochToMembers(s: Session, audienceId: string, epoch: number, epochPriv: Uint8Array, members: { id: string; encPub: Uint8Array }[]) {
    const rows = members.map((m) => ({
        audience_id: audienceId,
        epoch,
        member_id: m.id,
        wrapped_epoch_privkey: toBase64(wrapEpochKeyToMember(m.encPub, epochPriv, { audienceId, epoch, memberId: m.id })),
    }));
    await api.deleteEpochKeys(s.token, audienceId, epoch, members.map((m) => m.id));
    await api.insertEpochKeys(s.token, rows);
}

// --- Share filters and names ------------------------------------------------------------

export type ShareFilter = { projects: string[]; sinceDays: number };

// Go's shareFilter JSON: {"projects":[...],"since_days":N}.
const filterBytes = (f: ShareFilter) => utf8ToBytes(JSON.stringify({ projects: f.projects, since_days: f.sinceDays }));

async function currentFilter(s: Session, audienceId: string, key = epochKeys(s, audienceId)) {
    const shares = await api.getShares(s.token, audienceId);
    const sh = shares[0];
    if (!sh) return null;
    const plain = unwrapFilterFromEpoch(await key(sh.epoch), fromBase64(sh.filter_ciphertext), { audienceId, epoch: sh.epoch });
    const f = JSON.parse(bytesToUtf8(plain)) as { projects: string[] | null; since_days: number };
    return { filter: { projects: f.projects ?? [], sinceDays: f.since_days ?? 0 }, shareId: sh.id };
}

async function writeShare(s: Session, audienceId: string, shareId: string, epoch: number, epochPub: Uint8Array, filter: ShareFilter) {
    const ct = wrapFilterToEpoch(epochPub, filterBytes(filter), { audienceId, epoch });
    await api.upsertShare(s.token, { id: shareId, audience_id: audienceId, epoch, filter_ciphertext: toBase64(ct), created_by: s.userId });
}

async function sharedTeamName(s: Session, audienceId: string, key = epochKeys(s, audienceId)) {
    try {
        const row = (await api.getAudienceName(s.token, audienceId))[0];
        if (!row) return '';
        return bytesToUtf8(unwrapNameFromEpoch(await key(row.epoch), fromBase64(row.name_ciphertext), { audienceId, epoch: row.epoch }));
    } catch {
        return '';
    }
}

async function setSharedTeamName(s: Session, audienceId: string, name: string) {
    if (!name.trim()) return api.deleteAudienceName(s.token, audienceId);
    const verified = await verifiedEpochs(s, audienceId);
    const current = verified.at(-1);
    if (!current) throw new Error('This team has no epochs.');
    const ct = wrapNameToEpoch(current.epochPub, utf8ToBytes(name.trim()), { audienceId, epoch: current.epoch });
    await api.upsertAudienceName(s.token, { audience_id: audienceId, epoch: current.epoch, name_ciphertext: toBase64(ct), created_by: s.userId });
}

// --- Teams ---------------------------------------------------------------------------------

export type TeamMember = { userId: string; role: string; status: string; pinned: boolean; displayName: string; imageUrl: string };

export type Team = {
    id: string;
    name: string;
    role: string;
    createdBy: string;
    currentEpoch: number;
    // Invited but not yet accepted: the invitation shows, nothing else does.
    pending: boolean;
    invitedBy: string;
    members: TeamMember[];
};

const imageOf = (row?: api.IdentityRow) => row?.image_url ?? '';

export async function listTeams(account: Account): Promise<Team[]> {
    const s = await session(account);
    await pullPins(s);
    const [audiences, links] = await Promise.all([
        api.getAudiences(s.token),
        api.getLinkShares(s.token).catch((e) => {
            if (isMissingSchema(e)) return [];
            throw e;
        }),
    ]);
    // A capability link's audience is an implementation detail, never a team.
    const linkIds = new Set(links.map((l) => l.audience_id));
    const teams = audiences.filter((a) => !linkIds.has(a.id));
    const rosters = await api.getMembersByAudiences(s.token, teams.map((t) => t.id));
    const ids = teams.flatMap((t) => [t.created_by, ...(rosters.get(t.id) ?? []).map((m) => m.member_id)]);
    const identities = await api.getIdentities(s.token, ids);
    const names = loadTeamNames();
    const pins = loadPins();

    return Promise.all(
        teams.map(async (aud): Promise<Team> => {
            const members = rosters.get(aud.id) ?? [];
            const me = members.find((m) => m.member_id === s.userId);
            const pending = me?.status === 'invited';
            return {
                id: aud.id,
                name: names[aud.id] || (pending ? '' : await sharedTeamName(s, aud.id)),
                role: me?.role ?? '',
                createdBy: aud.created_by,
                currentEpoch: aud.current_epoch ?? 0,
                pending,
                invitedBy: pending ? (identities.get(aud.created_by)?.display_name ?? '') : '',
                members: pending
                    ? []
                    : members.map((m) => ({
                          userId: m.member_id,
                          role: m.role,
                          status: m.status ?? 'active',
                          pinned: isPinned(pins, m.member_id),
                          displayName: identities.get(m.member_id)?.display_name ?? '',
                          imageUrl: imageOf(identities.get(m.member_id)),
                      })),
            };
        }),
    );
}

// The caller's own profile on their identity, so others name them.
async function publishProfile(s: Session) {
    const { name, image } = s.account.user;
    if (!name?.trim() && !image?.trim()) return;
    // No email: an empty one leaves the published discovery hash alone.
    await publish(s.token, s.userId, s.id, { email: '', name, image }).catch(() => undefined);
}

export async function createTeam(account: Account, name: string) {
    const s = await session(account);
    await publishProfile(s);
    const id = randomHexId();
    await api.insertAudience(s.token, { id, created_by: s.userId });
    await api.insertMember(s.token, { audience_id: id, member_id: s.userId, role: 'admin' });
    const epochPriv = generateEpochKey();
    await publishEpoch(s, id, 1, '', epochPriv);
    await wrapEpochToMembers(s, id, 1, epochPriv, [{ id: s.userId, encPub: publicIdentity(s.id).encPub }]);
    // Our own key is trusted outright; repin covers a re-provisioned identity.
    savePins(markJoined(repin(loadPins(), s.userId, fingerprint(publicIdentity(s.id))), id));
    await pushPins(s);
    setTeamNameLocal(id, name);
    await setSharedTeamName(s, id, name).catch(() => undefined);
    return id;
}

// The local name always; the shared one too when the caller is an admin.
export async function renameTeam(account: Account, audienceId: string, name: string) {
    setTeamNameLocal(audienceId, name);
    const s = await session(account);
    await setSharedTeamName(s, audienceId, name).catch(() => undefined);
}

export async function deleteTeam(account: Account, audienceId: string) {
    const s = await session(account);
    await api.deleteAudience(s.token, audienceId);
    setTeamNameLocal(audienceId, null);
}

// Leaving (or declining an invitation) deletes only the caller's own row.
export async function leaveTeam(account: Account, audienceId: string) {
    const s = await session(account);
    await api.deleteMember(s.token, audienceId, s.userId);
    setTeamNameLocal(audienceId, null);
}

export async function acceptInvite(account: Account, audienceId: string) {
    const s = await session(account);
    await publishProfile(s);
    await api.updateMemberStatus(s.token, audienceId, s.userId, 'active');
    savePins(markJoined(loadPins(), audienceId));
    // Pinning is symmetric: trust the roster now visible, as the inviter
    // trusted us. A conflicting pin is a real key change, left for later.
    const members = await api.getMembers(s.token, audienceId).catch(() => []);
    for (const m of members) {
        if (m.member_id === s.userId || m.status !== 'active' || isPinned(loadPins(), m.member_id)) continue;
        const row = await api.getIdentity(s.token, m.member_id).catch(() => null);
        if (!row) continue;
        try {
            savePins(pin(loadPins(), m.member_id, fingerprint(publicFromRow(row))));
        } catch {
            // Best-effort per member.
        }
    }
    await pushPins(s);
}

// Adds someone by email, pinning their key on first sight; a different key
// from one pinned earlier adds nobody.
export async function inviteByEmail(account: Account, audienceId: string, email: string, role: 'member' | 'admin' = 'member') {
    const s = await session(account);
    await publishProfile(s);
    const hash = emailHash(email);
    if (!hash) throw new Error('Enter an email address.');
    const found = (await api.getIdentitiesByEmailHash(s.token, hash))[0];
    if (!found) throw new EmailNotFound();
    const userId = found.user_id;
    const pub = publicFromRow(found);
    try {
        savePins(pin(loadPins(), userId, fingerprint(pub)));
    } catch (e) {
        if (e instanceof PinConflict) throw new KeyChanged();
        throw e;
    }
    const verified = await verifiedEpochs(s, audienceId);
    if (verified.length === 0) throw new Error('This team has no epochs.');
    await api.insertMember(s.token, { audience_id: audienceId, member_id: userId, role, status: 'invited' });
    // History-visible join: every epoch's key, so the slice reads mid-epoch.
    const key = epochKeys(s, audienceId);
    for (const ann of verified) {
        await wrapEpochToMembers(s, audienceId, ann.epoch, await key(ann.epoch), [{ id: userId, encPub: pub.encPub }]);
    }
    await pushPins(s);
    return userId;
}

// Removal mints a new epoch for the remaining (pinned) members and re-wraps
// the share filter, so everything after it is dark to the removed member.
export async function removeMember(account: Account, audienceId: string, userId: string) {
    const s = await session(account);
    const verified = await verifiedEpochs(s, audienceId);
    const prev = verified.at(-1);
    if (!prev) throw new Error('This team has no epochs.');
    await api.deleteMember(s.token, audienceId, userId);
    const members = await api.getMembers(s.token, audienceId);
    const remaining = [];
    for (const m of members) {
        if (m.member_id === userId) continue;
        remaining.push({ id: m.member_id, encPub: (await pinnedIdentity(s, m.member_id)).encPub });
    }
    const epoch = prev.epoch + 1;
    const priv = generateEpochKey();
    await publishEpoch(s, audienceId, epoch, epochHash(prev), priv);
    await wrapEpochToMembers(s, audienceId, epoch, priv, remaining);
    savePins(checkEpochWatermark(loadPins(), audienceId, epoch));
    const existing = await currentFilter(s, audienceId);
    if (existing) await writeShare(s, audienceId, existing.shareId, epoch, epochPublicKey(priv), existing.filter);
}

export async function teamShare(account: Account, audienceId: string): Promise<ShareFilter & { hasShare: boolean }> {
    const s = await session(account);
    const current = await currentFilter(s, audienceId);
    return current ? { ...current.filter, hasShare: true } : { projects: [], sinceDays: 0, hasShare: false };
}

export async function setTeamShare(account: Account, audienceId: string, filter: ShareFilter) {
    const s = await session(account);
    const verified = await verifiedEpochs(s, audienceId);
    const current = verified.at(-1);
    if (!current) throw new Error('This team has no epochs.');
    const existing = await currentFilter(s, audienceId);
    await writeShare(s, audienceId, existing?.shareId ?? randomHexId(), current.epoch, current.epochPub, filter);
}

// --- Reading what others share ----------------------------------------------------------------

export type SharedEntry = {
    id: string;
    audienceId: string;
    authorId: string;
    description: string;
    project: string;
    start: string;
    end: string;
};

// A shared entry as the Log shows it: who it's from and through which team.
export type SharedActivity = SharedEntry & { authorName: string; authorImage: string; teamName: string };

type SharedCache = {
    userId: string;
    trust: string;
    entries: Record<string, { sig: string; entry: SharedEntry }>;
    activities?: SharedActivity[];
};

// The last read's result, for showing straight away while a fresh one runs.
export function cachedSharedActivities(userId: string): SharedActivity[] {
    const c = loadSharedCache<SharedCache>();
    return c?.userId === userId ? (c.activities ?? []) : [];
}

const grantLive = (g: api.GrantRow, now: number) => !g.revoked && !(g.valid_until && now >= Date.parse(g.valid_until));

// Every entry granted to the caller by someone else, decrypted and verified
// against its pinned author. An entry whose grant is unchanged since the last
// read is served from the phone's cache; the epoch chain is still verified.
export async function listSharedEntries(account: Account): Promise<{ entries: SharedActivity[]; errors: string[] }> {
    const s = await session(account);
    await pullPins(s);
    const trust = JSON.stringify(Object.entries(loadPins().fingerprints).sort());
    const prior = loadSharedCache<SharedCache>();
    const cache = prior && prior.userId === s.userId && prior.trust === trust ? prior.entries : {};
    const next: SharedCache['entries'] = {};
    const errors: string[] = [];
    const now = Date.now();
    const authors = new Map<string, PublicIdentity>();

    for (const aud of await api.getAudiences(s.token)) {
        try {
            const verified = await verifiedEpochs(s, aud.id, authors);
            if (verified.length === 0) continue;
            const grants = (await api.getGrantsForAudience(s.token, aud.id)).filter((g) => g.author_id !== s.userId && grantLive(g, now));
            const stale: api.GrantRow[] = [];
            for (const g of grants) {
                const key = `${aud.id}:${g.entry_id}`;
                const hit = cache[key];
                if (hit && hit.sig === g.author_sig) next[key] = hit;
                else stale.push(g);
            }
            if (stale.length === 0) continue;
            const key = epochKeys(s, aud.id);
            const byId = new Map(stale.map((g) => [g.entry_id, g]));
            for (const row of await api.getEntriesByIds(s.token, [...byId.keys()])) {
                const g = byId.get(row.id);
                if (!g || row.deleted) continue;
                try {
                    const entry = await decryptShared(s, aud.id, g, row, key, authors);
                    next[`${aud.id}:${row.id}`] = { sig: g.author_sig, entry };
                } catch (e) {
                    if (e instanceof NotPinned) throw e;
                    // One unreadable row is skipped, as on the desktop.
                }
            }
        } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }
    const entries = Object.values(next).map((v) => v.entry);
    const profiles = await api.getIdentities(s.token, entries.map((e) => e.authorId)).catch(() => new Map<string, api.IdentityRow>());
    const names = loadTeamNames();
    const activities = entries.map((e) => ({
        ...e,
        authorName: profiles.get(e.authorId)?.display_name ?? '',
        authorImage: imageOf(profiles.get(e.authorId)),
        teamName: names[e.audienceId] ?? '',
    }));
    saveSharedCache({ userId: s.userId, trust, entries: next, activities } satisfies SharedCache);
    return { entries: activities, errors };
}

async function decryptShared(
    s: Session,
    audienceId: string,
    g: api.GrantRow,
    row: api.SharedEntryRow,
    key: (epoch: number) => Promise<Uint8Array>,
    authors: Map<string, PublicIdentity>,
): Promise<SharedEntry> {
    const dek = unwrapDEKFromEpoch(await key(g.epoch), fromBase64(g.wrapped_dek), { entryId: row.id, audienceId, epoch: g.epoch });
    const author = await pinnedIdentity(s, row.user_id, authors);
    const ct = fromBase64(row.ciphertext);
    const aad = { entryId: row.id, version: row.version, authorId: row.user_id };
    if (!verifyEntrySig(author.sigPub, aad, ct, fromBase64(row.author_sig))) throw new Error('shared entry author signature invalid');
    const e = parseCanonical(open(dek, ct, fromBase64(row.nonce), entryAADBytes(aad)));
    return { id: row.id, audienceId, authorId: row.user_id, ...e };
}

// --- Granting the caller's own entries -------------------------------------------------------

const toParam = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Calendar days, as Go's AddDate counts them.
function addDays(d: Date, days: number) {
    const out = new Date(d);
    out.setDate(out.getDate() + days);
    return out;
}

function matches(f: ShareFilter, e: Entry, now: Date) {
    if (f.projects.length > 0 && !f.projects.includes(e.project)) return false;
    return !(f.sinceDays > 0 && parseSyncTime(e.start) < addDays(now, -f.sinceDays));
}

// Reconcile-on-write for every audience this account created or accepted:
// grant the entries the share's filter now selects, re-grant on a new epoch,
// and withdraw grants for entries that left the slice. Errors per audience are
// collected rather than stopping the others.
export async function reconcileShares(account: Account, entries: Entry[]): Promise<string[]> {
    const s = await session(account);
    const audiences = await api.getAudiences(s.token);
    await pullPins(s);
    let pins = loadPins();
    if (!pins.joined_seeded) {
        const rosters = await api.getMembersByAudiences(s.token, audiences.map((a) => a.id));
        const seed = audiences
            .filter((a) => a.created_by === s.userId || (rosters.get(a.id) ?? []).some((m) => m.member_id === s.userId && m.status === 'active'))
            .map((a) => a.id);
        savePins(seedJoined(pins, seed));
        await pushPins(s);
        pins = loadPins();
    }
    const errors: string[] = [];
    const now = new Date();
    for (const aud of audiences) {
        if (!pins.joined?.[aud.id]) continue;
        try {
            await reconcileAudience(s, aud.id, entries, now);
        } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }
    return errors;
}

async function reconcileAudience(s: Session, audienceId: string, entries: Entry[], now: Date) {
    const verified = await verifiedEpochs(s, audienceId);
    const current = verified.at(-1);
    if (!current) return;
    const share = await currentFilter(s, audienceId);
    if (!share) return;
    const existing = new Map((await api.getMyGrantsForAudience(s.token, audienceId, s.userId)).map((g) => [g.entry_id, g]));
    const desired = entries.filter((e) => matches(share.filter, e, now));
    const wanted = new Set(desired.map((e) => e.id));
    // Teammates verify the author's signature, which an entry first pushed in
    // the legacy format doesn't carry: re-push those signed before granting.
    await pushSignedEntries(s, desired.filter((e) => !e.signed));

    const rows: api.GrantRow[] = [];
    for (const e of desired) {
        const g = existing.get(e.id);
        if (g) {
            if (g.epoch === current.epoch && !g.revoked) continue;
            await api.deleteGrant(s.token, e.id, audienceId);
        }
        const aad = { entryId: e.id, audienceId, epoch: current.epoch };
        const wrapped = wrapDEKToEpoch(current.epochPub, deriveEntryDEK(s.dek, e.id), aad);
        const start = parseSyncTime(e.start);
        rows.push({
            entry_id: e.id,
            audience_id: audienceId,
            epoch: current.epoch,
            author_id: s.userId,
            wrapped_dek: toBase64(wrapped),
            author_sig: toBase64(signGrant(s.id, aad, wrapped)),
            valid_from: toParam(start),
            ...(share.filter.sinceDays > 0 ? { valid_until: toParam(addDays(start, share.filter.sinceDays)) } : {}),
        });
    }
    await api.insertGrants(s.token, rows);
    for (const id of existing.keys()) {
        if (!wanted.has(id)) await api.deleteGrant(s.token, id, audienceId);
    }
}
