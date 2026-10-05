import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

// The sketchpad stays on the device, as the desktop's stays in localStorage.
const pad = new File(Paths.document, 'sketchpad.html');
const RUNS_KEY = 'todos.runs';

export function readSketchpad() {
    try {
        return pad.exists ? pad.textSync() : '';
    } catch {
        return '';
    }
}

export function writeSketchpad(html: string) {
    try {
        pad.write(html);
    } catch {
        // The open pad still holds the text for this session.
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
