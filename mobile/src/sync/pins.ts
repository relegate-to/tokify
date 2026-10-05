// The fingerprint pin store (internal/integrations/neonsync/pins.go): who this
// account trusts, the highest epoch seen per audience, and the audiences it
// created or accepted. Pure functions over the file; the sharing service
// persists it and syncs it, sealed, through user_keys.

export type PinFile = {
    fingerprints: Record<string, string>;
    epochs: Record<string, number>;
    joined?: Record<string, boolean>;
    joined_seeded?: boolean;
};

export const emptyPins = (): PinFile => ({ fingerprints: {}, epochs: {}, joined: {} });

export function parsePins(text: string): PinFile {
    const f = JSON.parse(text) as Partial<PinFile>;
    return { fingerprints: f.fingerprints ?? {}, epochs: f.epochs ?? {}, joined: f.joined ?? {}, joined_seeded: f.joined_seeded || undefined };
}

// Go's json.Marshal of pinFile: map keys sorted, empty joined fields omitted.
export function exportPins(f: PinFile): string {
    const sorted = <T>(m: Record<string, T>) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
    const out: PinFile = { fingerprints: sorted(f.fingerprints), epochs: sorted(f.epochs) };
    if (f.joined && Object.keys(f.joined).length) out.joined = sorted(f.joined);
    if (f.joined_seeded) out.joined_seeded = true;
    return JSON.stringify(out);
}

export class PinConflict extends Error {}

// Trust on first use; a different fingerprint later is a swapped key and is
// refused rather than overwritten.
export function pin(f: PinFile, userId: string, fp: string): PinFile {
    const existing = f.fingerprints[userId];
    if (existing !== undefined) {
        if (existing !== fp) throw new PinConflict(`pin conflict for ${userId}: pinned fingerprint does not match`);
        return f;
    }
    return { ...f, fingerprints: { ...f.fingerprints, [userId]: fp } };
}

// Only ever for the caller's own identity, which can't be swapped against itself.
export const repin = (f: PinFile, userId: string, fp: string): PinFile =>
    f.fingerprints[userId] === fp ? f : { ...f, fingerprints: { ...f.fingerprints, [userId]: fp } };

export const isPinned = (f: PinFile, userId: string) => f.fingerprints[userId] !== undefined;
export const verifyPin = (f: PinFile, userId: string, fp: string) => f.fingerprints[userId] === fp;

// Another device's pins folded in: local fingerprints win any conflict, epoch
// marks take the max, joined audiences union.
export function mergePins(local: PinFile, remote: PinFile): PinFile {
    const fingerprints = { ...local.fingerprints };
    for (const [id, fp] of Object.entries(remote.fingerprints)) if (!(id in fingerprints)) fingerprints[id] = fp;
    const epochs = { ...local.epochs };
    for (const [aud, n] of Object.entries(remote.epochs)) if (n > (epochs[aud] ?? 0)) epochs[aud] = n;
    const joined = { ...local.joined };
    for (const aud of Object.keys(remote.joined ?? {})) joined[aud] = true;
    return { fingerprints, epochs, joined, joined_seeded: local.joined_seeded || remote.joined_seeded || undefined };
}

// Fewer epochs than ever seen means a truncated history: a hard stop.
export function checkEpochWatermark(f: PinFile, audienceId: string, observed: number): PinFile {
    const prev = f.epochs[audienceId];
    if (prev !== undefined && observed < prev) {
        throw new Error(`audience ${audienceId}: epoch history truncated (saw ${observed}, expected at least ${prev})`);
    }
    return (prev ?? 0) < observed ? { ...f, epochs: { ...f.epochs, [audienceId]: observed } } : f;
}

export const markJoined = (f: PinFile, audienceId: string): PinFile => (f.joined?.[audienceId] ? f : { ...f, joined: { ...f.joined, [audienceId]: true } });

// Adopts the memberships that predate the joined set, once.
export function seedJoined(f: PinFile, audienceIds: string[]): PinFile {
    if (f.joined_seeded) return f;
    const joined = { ...f.joined };
    for (const id of audienceIds) joined[id] = true;
    return { ...f, joined, joined_seeded: true };
}
