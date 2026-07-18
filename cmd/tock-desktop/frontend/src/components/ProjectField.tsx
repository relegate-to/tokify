import { useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';

export function ProjectField({
    value,
    onChange,
    suggestions,
    placeholder = 'project (optional)',
}: {
    value: string;
    onChange: (v: string) => void;
    suggestions: string[];
    placeholder?: string;
}) {
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Keep the current value visible as a chip even before it lands in the
    // activity log (a freshly created project isn't in `suggestions` yet).
    const chips =
        value && !suggestions.includes(value)
            ? [value, ...suggestions]
            : suggestions;

    const startCreating = () => {
        setDraft('');
        setCreating(true);
    };

    const commitDraft = () => {
        const name = draft.trim();
        if (name) onChange(name);
        setCreating(false);
        setDraft('');
    };

    return (
        <div className="flex flex-wrap items-center gap-1">
            {chips.map((p) => {
                const active = value === p;
                return (
                    <button
                        key={p}
                        type="button"
                        onClick={() => onChange(active ? '' : p)}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors',
                            active
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                    >
                        {active ? (
                            <Check className="size-3" />
                        ) : (
                            <span
                                aria-hidden
                                className="size-1.5 rounded-full"
                                style={{ backgroundColor: projectColor(p) }}
                            />
                        )}
                        {p}
                    </button>
                );
            })}

            {creating ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-foreground/40 bg-background px-2 py-0.5 text-xs shadow-sm animate-in fade-in-0 zoom-in-95 duration-150">
                    <span
                        aria-hidden
                        className="size-1.5 rounded-full transition-colors"
                        style={{ backgroundColor: projectColor(draft) }}
                    />
                    <input
                        ref={inputRef}
                        value={draft}
                        autoFocus
                        aria-label="New project name"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                commitDraft();
                            } else if (e.key === 'Escape') {
                                setCreating(false);
                                setDraft('');
                            }
                        }}
                        onBlur={commitDraft}
                        placeholder="name…"
                        autoComplete="off"
                        spellCheck={false}
                        size={8}
                        className="min-w-16 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                    />
                </span>
            ) : (
                <button
                    type="button"
                    onClick={startCreating}
                    title="New project"
                    aria-label="New project"
                    className="inline-flex size-5 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground transition-all hover:border-foreground hover:bg-muted hover:text-foreground active:scale-90"
                >
                    <Plus className="size-3" />
                </button>
            )}

            {chips.length === 0 && !creating && (
                <span className="text-xs text-muted-foreground">
                    {placeholder}
                </span>
            )}
        </div>
    );
}
