import type { hotkeys } from '../../wailsjs/go/models';

// Tokify's configurable shortcuts. The actions and the rules a set of bindings
// must follow live in internal/app/hotkeys; this is the window's half: names
// for Settings, turning a key press into a shortcut, and matching one.

export type Shortcut = hotkeys.Shortcut;
export type Binding = hotkeys.Binding;

// Mirrors hotkeys.Actions(), in the order Settings shows them.
export const HOTKEY_ACTIONS: { action: string; label: string; description: string }[] = [
    { action: 'toggle-timer', label: 'Start or stop the timer', description: 'Stops what’s running, or resumes your last activity.' },
    { action: 'stop-timer', label: 'Stop the timer', description: 'Stops the running activity.' },
    { action: 'resume-last', label: 'Resume last activity', description: 'Starts your last activity again.' },
    { action: 'new-activity', label: 'New activity', description: 'Opens Tokify ready to type what you’re working on.' },
    { action: 'show-tokify', label: 'Show Tokify', description: 'Brings Tokify to the front.' },
    { action: 'view-now', label: 'Go to Activity', description: '' },
    { action: 'view-log', label: 'Go to Log', description: '' },
    { action: 'view-sketchpad', label: 'Go to Notes', description: 'The sketchpad left of Activity.' },
    { action: 'view-reports', label: 'Go to Reports', description: '' },
    { action: 'view-charts', label: 'Go to Charts', description: '' },
    { action: 'view-stats', label: 'Go to Stats', description: '' },
    { action: 'open-settings', label: 'Open Settings', description: '' },
];

// Keys that only modify; pressing one alone records nothing yet.
const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'CapsLock', 'Fn']);

// The shortcut a key press makes, or null for a modifier on its own.
export function shortcutFromEvent(e: KeyboardEvent): Shortcut | null {
    if (MODIFIER_CODES.has(e.code) || !e.code) return null;
    return { key: e.code, cmd: e.metaKey || undefined, ctrl: e.ctrlKey || undefined, alt: e.altKey || undefined, shift: e.shiftKey || undefined };
}

export function sameShortcut(a: Shortcut, b: Shortcut) {
    return a.key === b.key && !!a.cmd === !!b.cmd && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}

export function hasModifier(s: Shortcut) {
    return !!(s.cmd || s.ctrl || s.alt || s.shift);
}

export const isFunctionKey = (code: string) => /^F\d{1,2}$/.test(code);

const KEY_LABELS: Record<string, string> = {
    Space: 'Space', Enter: '↩', Tab: '⇥', Backspace: '⌫', Escape: '⎋', Delete: '⌦',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟',
    Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Quote: "'", Semicolon: ';', Backslash: '\\',
    Comma: ',', Slash: '/', Period: '.', Backquote: '`',
};

// The shortcut as macOS menus write it, e.g. ⌃⌥⌘T (hotkeys.Shortcut.String).
export function formatShortcut(s: Shortcut) {
    const key = s.key.startsWith('Key') ? s.key.slice(3) : s.key.startsWith('Digit') ? s.key.slice(5) : (KEY_LABELS[s.key] ?? s.key);
    return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.cmd ? '⌘' : ''}${key}`;
}

// The window's own shortcuts: a bare key (no ⌘, ⌃ or ⌥) never fires while
// typing in a field, so a single-letter binding can't eat what's being typed.
export function matchInWindow(bindings: Binding[], e: KeyboardEvent): Binding | undefined {
    const pressed = shortcutFromEvent(e);
    if (!pressed) return undefined;
    const target = e.target as HTMLElement | null;
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
    return bindings.find((b) => !b.global && sameShortcut(b.shortcut, pressed) && !(typing && !(pressed.cmd || pressed.ctrl || pressed.alt)));
}

// Window event the Starter listens for to take focus (the New activity action).
export const FOCUS_STARTER_EVENT = 'tokify:focus-starter';
