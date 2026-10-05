import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { setColorOverrides } from '@/lib/colors';
import { dataToken, type Account } from '@/sync/account';
import { syncColors, type Colors } from '@/sync/project-colors';

// The account's project colors on this phone: read before the first frame,
// changed by the Projects page, and synced with the other devices after the
// history loads.
const file = new File(Paths.document, 'project-colors.json');
const MIN_GAP_MS = 60_000;

let colors: Colors = read();
let version = 0;
const listeners = new Set<() => void>();
setColorOverrides(colors);

function read(): Colors {
    try {
        return file.exists ? (JSON.parse(file.textSync()) as Colors) : {};
    } catch {
        return {};
    }
}

function adopt(next: Colors) {
    colors = next;
    try {
        file.write(JSON.stringify(next));
    } catch {
        // Still applied for this session.
    }
    setColorOverrides(next);
    version++;
    listeners.forEach((l) => l());
}

// Re-renders a component when colors change, for views that memoize rows.
export function useColorsVersion() {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => version,
    );
}

export const projectColors = () => colors;

// Pins a project to a palette color, or (null) back to its name's default.
export function chooseColor(account: Account, project: string, index: number | null) {
    adopt({ ...colors, [project]: { color: index === null ? '' : `var(--project-color-${index})`, at: new Date().toISOString() } });
    syncProjectColors(account, true);
}

let running = false;
let last = 0;

export async function syncProjectColors(account: Account, force = false) {
    if (running || (!force && Date.now() - last < MIN_GAP_MS)) return;
    running = true;
    last = Date.now();
    try {
        const merged = await syncColors(await dataToken(), account.dek, account.user.id, colors);
        const changed = Object.keys(merged).length !== Object.keys(colors).length || Object.entries(merged).some(([k, v]) => colors[k]?.color !== v.color || colors[k]?.at !== v.at);
        if (changed) adopt(merged);
    } catch {
        // Cosmetic; the next pass retries.
    } finally {
        running = false;
    }
}

export function clearProjectColors() {
    adopt({});
}
