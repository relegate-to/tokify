import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import { dataToken, type Account } from '@/sync/account';
import { padApi, reconcilePad, type Agreed } from '@/sync/sketchpad';
import { mergeSketchpad } from '@/sync/sketchpad-merge';

// The sketchpad on this phone, synced with the account's other devices through
// the sketchpad record. Alongside it is the record this phone last agreed with,
// so edits made offline are still known as this phone's own.
const pad = new File(Paths.document, 'sketchpad.html');
const agreedFile = new File(Paths.document, 'sketchpad-sync.json');
const RUNS_KEY = 'todos.runs';
const SAVE_SYNC_MS = 2_000;

function read() {
    try {
        return pad.exists ? pad.textSync() : '';
    } catch {
        return '';
    }
}

function readAgreed(): Agreed {
    try {
        if (agreedFile.exists) return JSON.parse(agreedFile.textSync()) as Agreed;
    } catch {
        // Unreadable: the next sync merges as if from empty, losing nothing.
    }
    return { owner: '', version: 0, html: '' };
}

function store(file: File, text: string) {
    try {
        file.write(text);
    } catch {
        // Still held in memory for this session.
    }
}

let text = read();
let agreed = readAgreed();
const listeners = new Set<(html: string) => void>();

export const sketchpadText = () => text;

export function onSketchpad(listener: (html: string) => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function adopt(html: string) {
    text = html;
    store(pad, html);
    listeners.forEach((l) => l(html));
}

// Stores an edit the editor made from base, merged with whatever a sync brought
// in meanwhile, and returns the pad as it now stands.
export function saveSketchpad(account: Account | null, html: string, base: string) {
    const next = text === base ? html : mergeSketchpad(base, html, text);
    text = next;
    store(pad, next);
    if (next !== html) listeners.forEach((l) => l(next));
    if (account) syncSoon(account);
    return next;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function syncSoon(account: Account) {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        syncSketchpad(account);
    }, SAVE_SYNC_MS);
}

let syncing = false;

// Shares the pad with the account's other devices. Quiet on failure; the next
// sync retries.
export async function syncSketchpad(account: Account) {
    if (syncing) return;
    syncing = true;
    try {
        const synced = text;
        const remote = await reconcilePad(padApi(dataToken, account.dek, account.user.id), synced, agreed);
        if (!remote) return;
        agreed = { owner: remote.owner, version: remote.version, html: remote.html };
        store(agreedFile, JSON.stringify(agreed));
        // Merged with any edit saved while the sync was on the network.
        const next = mergeSketchpad(synced, text, remote.html);
        if (next !== text) adopt(next);
    } catch {
        // Offline or locked; the next sync retries.
    } finally {
        syncing = false;
    }
}

// Ticks off the to-do with this id. The desktop does this on a parsed
// document; the pad's HTML comes from tiptap, so the to-do's own <li> tag is
// enough to find and flip.
export function completeTodo(html: string, id: string) {
    const tag = new RegExp(`<li\\b[^>]*\\bdata-todo-id="${id.replace(/[^\w-]/g, '')}"[^>]*>`);
    const match = html.match(tag);
    if (!match) return null;
    const ticked = match[0].replace(/\bdata-checked="[^"]*"/, 'data-checked="true"');
    return html.replace(match[0], ticked);
}

// A todo run links an activity (by start time) to the to-do it was started from.
export type TodoRun = { start: string; id: string; description: string };

export async function readTodoRuns(): Promise<TodoRun[]> {
    try {
        const runs = JSON.parse((await SecureStore.getItemAsync(RUNS_KEY)) ?? '[]');
        return Array.isArray(runs) ? runs : [];
    } catch {
        return [];
    }
}

export async function writeTodoRuns(runs: TodoRun[]) {
    await SecureStore.setItemAsync(RUNS_KEY, JSON.stringify(runs)).catch(() => undefined);
}
