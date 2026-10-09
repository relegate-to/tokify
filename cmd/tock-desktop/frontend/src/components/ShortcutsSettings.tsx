import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';

import { HotkeyDefaults, PauseHotkeys, SetHotkeys } from '../../wailsjs/go/main/App';
import { hotkeys } from '../../wailsjs/go/models';
import { Button } from '@/components/ui/button';
import { formatShortcut, hasModifier, HOTKEY_ACTIONS, isFunctionKey, sameShortcut, shortcutFromEvent, type Binding, type Shortcut } from '@/lib/hotkeys';
import { cn } from '@/lib/utils';

const labelOf = (action: string) => HOTKEY_ACTIONS.find((a) => a.action === action)?.label ?? action;

// Keyboard shortcuts in Settings: each action takes one shortcut, recorded by
// pressing it, and can be made to work from any app ("Anywhere"). The Go side
// validates and saves the set, and registers the global ones with macOS.
export function ShortcutsSettings({ bindings, onChange }: { bindings: Binding[]; onChange: (next: Binding[]) => void }) {
    const [recording, setRecording] = useState<string | null>(null);

    const save = async (next: Binding[]) => {
        try {
            const refused = await SetHotkeys(next.map((b) => hotkeys.Binding.createFrom(b)));
            onChange(next);
            for (const msg of refused ?? []) toast.warning(msg);
        } catch (e) {
            toast.error(String(e).replace(/^.*invalid shortcut: /, ''));
        }
    };

    const assign = (action: string, shortcut: Shortcut | null) => {
        const current = bindings.find((b) => b.action === action);
        let next = bindings.filter((b) => b.action !== action);
        if (shortcut) {
            const taken = next.find((b) => sameShortcut(b.shortcut, shortcut));
            if (taken) {
                // Moving a shortcut is the common case; say what lost it.
                next = next.filter((b) => b !== taken);
                toast.message(`${formatShortcut(shortcut)} moved from “${labelOf(taken.action)}”`);
            }
            const global = !!current?.global && (hasModifier(shortcut) || isFunctionKey(shortcut.key));
            next.push({ action, shortcut, global } as Binding);
        }
        save(next);
    };

    const setGlobal = (b: Binding, global: boolean) => {
        if (global && !hasModifier(b.shortcut) && !isFunctionKey(b.shortcut.key)) {
            toast.error('Add ⌘, ⌃, ⌥ or ⇧ to use this shortcut from any app.');
            return;
        }
        save(bindings.map((x) => (x.action === b.action ? ({ ...x, global } as Binding) : x)));
    };

    // While recording, the next key press is the shortcut: global ones are
    // lifted so pressing one already in use records it instead of running it.
    useEffect(() => {
        if (!recording) return;
        PauseHotkeys(true).catch(() => {});
        const onKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
            if (plain && e.code === 'Escape') return setRecording(null);
            if (plain && (e.code === 'Backspace' || e.code === 'Delete')) {
                assign(recording, null);
                return setRecording(null);
            }
            const shortcut = shortcutFromEvent(e);
            if (!shortcut) return;
            assign(recording, shortcut);
            setRecording(null);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            PauseHotkeys(false).catch(() => {});
        };
        // assign reads the current bindings; re-subscribing per change is fine.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recording, bindings]);

    const reset = () =>
        HotkeyDefaults()
            .then((d) => save(d ?? []))
            .catch((e) => toast.error(String(e)));

    return (
        <div className="flex flex-col divide-y rounded-xl border bg-card shadow-sm">
            {HOTKEY_ACTIONS.map(({ action, label, description }) => {
                const b = bindings.find((x) => x.action === action);
                const isRecording = recording === action;
                return (
                    <div key={action} className="flex items-center justify-between gap-4 px-4 py-2.5 compact:flex-col compact:items-start compact:gap-2">
                        <div className="flex min-w-0 flex-col">
                            <span className="text-sm">{label}</span>
                            {description && <span className="text-xs text-muted-foreground">{description}</span>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {b && (
                                <label
                                    className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground"
                                    title="Works even when another app is in front"
                                >
                                    <input
                                        type="checkbox"
                                        checked={!!b.global}
                                        onChange={(e) => setGlobal(b, e.target.checked)}
                                        className="size-3.5 cursor-pointer accent-foreground"
                                    />
                                    Anywhere
                                </label>
                            )}
                            <button
                                type="button"
                                onClick={() => setRecording(isRecording ? null : action)}
                                aria-label={b ? `${label}: ${formatShortcut(b.shortcut)}. Change shortcut` : `Set a shortcut for ${label}`}
                                className={cn(
                                    'min-w-24 rounded-md border px-2.5 py-1 text-center font-mono text-xs tabular-nums transition-colors',
                                    isRecording
                                        ? 'border-ring bg-muted text-foreground'
                                        : b
                                          ? 'bg-muted/40 text-foreground hover:bg-muted'
                                          : 'border-dashed text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                                )}
                            >
                                {isRecording ? 'Press keys…' : b ? formatShortcut(b.shortcut) : 'Set shortcut'}
                            </button>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                className={cn('text-muted-foreground', !b && 'invisible')}
                                onClick={() => assign(action, null)}
                                title="Remove shortcut"
                                aria-label={`Remove the shortcut for ${label}`}
                            >
                                <X />
                            </Button>
                        </div>
                    </div>
                );
            })}
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="text-xs text-muted-foreground">
                    {recording ? 'Press the new shortcut. Esc cancels, ⌫ removes it.' : 'Click a shortcut to change it.'}
                </span>
                <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
                    <RotateCcw data-icon="inline-start" />
                    Reset to defaults
                </Button>
            </div>
        </div>
    );
}
