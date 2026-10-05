// Sharing state kept on this phone: the pin store (public fingerprints and
// epoch counts, as the desktop keeps neonsync-pins.json), team names given on
// this device, and the decrypted shared entries from the last read.
import { File, Paths } from 'expo-file-system';

import { emptyPins, exportPins, parsePins, type PinFile } from './pins';

const pinsFile = new File(Paths.document, 'sharing-pins.json');
const namesFile = new File(Paths.document, 'sharing-team-names.json');
const sharedFile = new File(Paths.document, 'sharing-shared.json');

function readText(f: File) {
    try {
        return f.exists ? f.textSync() : null;
    } catch {
        return null;
    }
}

function writeText(f: File, text: string) {
    try {
        f.write(text);
    } catch {
        // The in-memory value still serves this session.
    }
}

let pins: PinFile | null = null;

export function loadPins(): PinFile {
    if (pins) return pins;
    const text = readText(pinsFile);
    try {
        pins = text ? parsePins(text) : emptyPins();
    } catch {
        pins = emptyPins();
    }
    return pins;
}

// Persists only a real change, and reports whether there was one.
export function savePins(next: PinFile) {
    const before = pins;
    pins = next;
    if (before && exportPins(before) === exportPins(next)) return false;
    writeText(pinsFile, exportPins(next));
    return true;
}

export function loadTeamNames(): Record<string, string> {
    try {
        return JSON.parse(readText(namesFile) ?? '{}') as Record<string, string>;
    } catch {
        return {};
    }
}

export function setTeamNameLocal(id: string, name: string | null) {
    const names = loadTeamNames();
    if (name?.trim()) names[id] = name.trim();
    else delete names[id];
    writeText(namesFile, JSON.stringify(names));
}

export function loadSharedCache<T>(): T | null {
    try {
        const text = readText(sharedFile);
        return text ? (JSON.parse(text) as T) : null;
    } catch {
        return null;
    }
}

export function saveSharedCache(value: unknown) {
    writeText(sharedFile, JSON.stringify(value));
}

export function clearSharingState() {
    pins = null;
    for (const f of [pinsFile, namesFile, sharedFile]) {
        try {
            if (f.exists) f.delete();
        } catch {
            // Nothing to keep from a signed-out session either way.
        }
    }
}
