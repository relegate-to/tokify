import { useEffect, useRef, useState, type KeyboardEventHandler } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';

import { pad } from '@/lib/time';
import { useTimePicker } from '@/lib/time-input';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_STEPS = Array.from({ length: 12 }, (_, i) => i * 5);
const ROW = 28;
const VISIBLE_ROWS = 5;

// An HH:MM time of day, always typed. Clicking it also offers hour and minute
// columns (unless the Time picker setting is off); picking from them writes
// into the same field.
export function TimeField({
    value,
    onValueChange,
    compact = false,
    autoFocus,
    onKeyDown,
    'aria-label': ariaLabel,
}: {
    value: string;
    onValueChange: (v: string) => void;
    compact?: boolean;
    autoFocus?: boolean;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    'aria-label'?: string;
}) {
    const picker = useTimePicker();
    const [open, setOpen] = useState(picker && !!autoFocus);
    const anchorRef = useRef<HTMLDivElement>(null);

    const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(value);
    const hour = m && Number(m[1]) < 24 ? Number(m[1]) : null;
    const minute = m && Number(m[2]) < 60 ? Number(m[2]) : null;
    // A typed minute off the 5-minute grid still gets a row of its own.
    const minutes =
        minute === null || minute % 5 === 0
            ? MINUTE_STEPS
            : [...MINUTE_STEPS, minute].sort((a, b) => a - b);

    const input = (
        <Input
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onClick={() => picker && setOpen(true)}
            onKeyDown={(e) => {
                if (open && e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                    return;
                }
                if (e.key === 'Enter') setOpen(false);
                onKeyDown?.(e);
            }}
            placeholder="HH:MM"
            aria-label={ariaLabel}
            className={cn(
                compact ? 'h-6 w-[70px] text-xs' : 'h-8 w-20',
                'px-2 text-center font-mono tabular-nums',
            )}
        />
    );

    if (!picker) return input;

    return (
        <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
            <PopoverPrimitive.Anchor asChild>
                <div ref={anchorRef}>{input}</div>
            </PopoverPrimitive.Anchor>
            {/* Not portalled: inside a dialog, the dialog's scroll lock only
                lets the wheel through to its own subtree. swiper-no-swiping
                stops the page swiper blurring the field on every pick. */}
            <PopoverPrimitive.Content
                align="center"
                sideOffset={6}
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
                onInteractOutside={(e) => {
                    if (anchorRef.current?.contains(e.target as Node)) {
                        e.preventDefault();
                    }
                }}
                className="swiper-no-swiping z-[60] flex gap-1 rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
                <TimeColumn
                    label="Hour"
                    values={HOURS}
                    selected={hour}
                    onPick={(h) => onValueChange(`${pad(h)}:${pad(minute ?? 0)}`)}
                />
                <TimeColumn
                    label="Minute"
                    values={minutes}
                    selected={minute}
                    onPick={(min) => {
                        onValueChange(`${pad(hour ?? 0)}:${pad(min)}`);
                        setOpen(false);
                    }}
                />
            </PopoverPrimitive.Content>
        </PopoverPrimitive.Root>
    );
}

function TimeColumn({
    label,
    values,
    selected,
    onPick,
}: {
    label: string;
    values: number[];
    selected: number | null;
    onPick: (v: number) => void;
}) {
    const listRef = useRef<HTMLDivElement>(null);
    const mounted = useRef(false);

    // Keep the selection in the middle row, like a wheel: instantly when the
    // column opens, then gliding as typing or picking moves it.
    useEffect(() => {
        const list = listRef.current;
        if (!list || selected === null) return;
        list.scrollTo({
            top: values.indexOf(selected) * ROW,
            behavior: mounted.current ? 'smooth' : 'instant',
        });
        mounted.current = true;
    }, [selected, values]);

    return (
        <div
            ref={listRef}
            role="listbox"
            aria-label={label}
            className="overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_35%,black_65%,transparent)]"
            style={{
                height: VISIBLE_ROWS * ROW,
                paddingBlock: ((VISIBLE_ROWS - 1) / 2) * ROW,
            }}
        >
            {values.map((v) => (
                <button
                    key={v}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={v === selected}
                    // Keep focus, and the caret, in the typed field.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(v)}
                    className={cn(
                        'flex w-10 items-center justify-center rounded-md font-mono text-sm tabular-nums transition-colors',
                        v === selected
                            ? 'bg-muted text-foreground'
                            : 'text-muted-foreground hover:text-foreground',
                    )}
                    style={{ height: ROW }}
                >
                    {pad(v)}
                </button>
            ))}
        </div>
    );
}
