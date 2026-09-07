import { useState } from 'react';
import { Check } from 'lucide-react';

import { projectColor } from '@/lib/colors';
import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

// The hero's project slot: one dot and one name, not the chip row the dialogs
// use. Picking, clearing, and naming a new project all happen in the popover so
// the idle card keeps its single-line bottom row.
export function ProjectPicker({
    value,
    onChange,
    suggestions,
}: {
    value: string;
    onChange: (v: string) => void;
    suggestions: string[];
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');

    const draft = query.trim();
    const canCreate =
        draft.length > 0 &&
        !suggestions.some((p) => p.toLowerCase() === draft.toLowerCase());

    const choose = (next: string) => {
        onChange(next);
        setQuery('');
        setOpen(false);
    };

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) setQuery('');
            }}
        >
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={value ? `Project: ${value}` : 'Choose project'}
                    className="flex min-w-0 items-center gap-2 text-sm font-medium text-secondary-foreground transition-colors hover:text-foreground"
                >
                    <span
                        aria-hidden
                        className="size-[7px] shrink-0 rounded-[2px]"
                        style={{
                            backgroundColor: value
                                ? projectColor(value)
                                : 'var(--idle-dot)',
                        }}
                    />
                    <span className="truncate">{value || 'No project'}</span>
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 p-0">
                <Command>
                    <CommandInput
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Search or name a project…"
                    />
                    <CommandList>
                        <CommandEmpty>No projects yet.</CommandEmpty>
                        {canCreate && (
                            <CommandItem
                                value={`__create__${draft}`}
                                onSelect={() => choose(draft)}
                            >
                                <span
                                    aria-hidden
                                    className="size-[7px] shrink-0 rounded-[2px]"
                                    style={{
                                        backgroundColor: projectColor(draft),
                                    }}
                                />
                                Use “{draft}”
                            </CommandItem>
                        )}
                        {value && (
                            <CommandItem
                                value="__clear__"
                                onSelect={() => choose('')}
                            >
                                <span
                                    aria-hidden
                                    className="size-[7px] shrink-0 rounded-[2px] bg-idle-dot"
                                />
                                No project
                            </CommandItem>
                        )}
                        {suggestions.map((p) => (
                            <CommandItem
                                key={p}
                                value={p}
                                onSelect={() => choose(p)}
                            >
                                <span
                                    aria-hidden
                                    className="size-[7px] shrink-0 rounded-[2px]"
                                    style={{ backgroundColor: projectColor(p) }}
                                />
                                <span className="truncate">{p}</span>
                                {value === p && (
                                    <Check className="ml-auto size-3.5 opacity-70" />
                                )}
                            </CommandItem>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
