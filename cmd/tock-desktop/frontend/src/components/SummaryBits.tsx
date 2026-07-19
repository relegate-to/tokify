import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { formatTotal } from '@/lib/time';
import type { LegendItem, Seg, StackBar } from '@/lib/summary';

// The summary views share one visual language: a soft "anchor band" for the
// headline number and plain card panels for the detail below. Both echo the
// tokens the rest of the app already uses (subtle-surface, card ring).
export function Band({
    className,
    style,
    children,
}: {
    className?: string;
    style?: React.CSSProperties;
    children: ReactNode;
}) {
    return (
        <div
            style={style}
            className={cn(
                'rounded-2xl bg-subtle-surface p-6 ring-1 ring-subtle-surface-border',
                className,
            )}
        >
            {children}
        </div>
    );
}

export function Panel({
    className,
    style,
    children,
}: {
    className?: string;
    style?: React.CSSProperties;
    children: ReactNode;
}) {
    return (
        <div
            style={style}
            className={cn(
                'rounded-2xl bg-card p-5 ring-1 ring-foreground/10',
                className,
            )}
        >
            {children}
        </div>
    );
}

export function Eyebrow({
    className,
    children,
}: {
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                'text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80',
                className,
            )}
        >
            {children}
        </div>
    );
}

export function Segmented<T extends string>({
    options,
    value,
    onChange,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
}) {
    return (
        <div className="flex items-center gap-0.5 rounded-lg bg-navigation p-[3px]">
            {options.map((o) => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        onClick={() => onChange(o.value)}
                        className={cn(
                            'rounded-md px-3.5 py-1.5 text-[13px] transition-colors',
                            active
                                ? 'bg-navigation-active font-semibold text-navigation-active-foreground shadow-[var(--navigation-shadow)]'
                                : 'font-medium text-navigation-muted-foreground hover:text-foreground',
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

// A thin composition strip: the period's project mix as one horizontal bar.
// Reads the hero total's makeup at a glance without competing with the number.
export function MixRibbon({ mix, total }: { mix: Seg[]; total: number }) {
    if (total <= 0 || mix.length === 0) {
        return <div className="h-2 rounded-full bg-muted" />;
    }
    return (
        <div className="flex h-2 items-stretch gap-[3px]">
            {mix.map((seg) => (
                <div
                    key={seg.project}
                    title={`${seg.label} · ${formatTotal(seg.ms)}`}
                    className="min-w-[3px] rounded-full first:rounded-l-full last:rounded-r-full"
                    style={{
                        width: `${(seg.ms / total) * 100}%`,
                        background: seg.color,
                    }}
                />
            ))}
        </div>
    );
}

export function ProjectLegend({
    items,
    className,
}: {
    items: LegendItem[];
    className?: string;
}) {
    if (items.length === 0) return null;
    return (
        <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
            {items.map((it) => (
                <div key={it.name} className="flex items-center gap-1.5">
                    <span
                        className="size-2 rounded-full"
                        style={{ background: it.color }}
                    />
                    <span className="text-[12px] text-muted-foreground">
                        {it.name}
                    </span>
                </div>
            ))}
        </div>
    );
}

// Column chart where every column is a stack of project-colored segments. The
// tallest column's value is pinned so the peak reads without hovering; the rest
// reveal on hover. Segments carry the project palette — that's the whole point.
export function StackedBarChart({
    bars,
    heightClass = 'h-[136px]',
    barMaxWidth = 30,
    gapClass = 'gap-2.5',
    pinPeak = true,
}: {
    bars: StackBar[];
    heightClass?: string;
    barMaxWidth?: number;
    gapClass?: string;
    pinPeak?: boolean;
}) {
    const max = Math.max(...bars.map((b) => b.total), 1);
    const peak = bars.reduce(
        (best, b, i) => (b.total > bars[best].total ? i : best),
        0,
    );
    return (
        <div className={cn('flex items-end', gapClass, heightClass)}>
            {bars.map((b, i) => {
                const showValue = b.pinned || (pinPeak && i === peak && b.total > 0);
                return (
                    <div
                        key={`${b.label}-${i}`}
                        className="group/bar flex h-full flex-1 flex-col items-center justify-end gap-2"
                    >
                        <div
                            className={cn(
                                'font-mono text-[11px] tabular-nums text-muted-foreground transition-opacity duration-150',
                                showValue
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover/bar:opacity-100',
                            )}
                        >
                            {b.total > 0 ? formatTotal(b.total) : '—'}
                        </div>
                        <div
                            className="flex w-[64%] flex-1 flex-col-reverse justify-start gap-[2px]"
                            style={{ maxWidth: barMaxWidth }}
                        >
                            {b.segments.length === 0 ? (
                                <div className="h-[3px] rounded-full bg-muted" />
                            ) : (
                                b.segments.map((seg) => (
                                    <div
                                        key={seg.project}
                                        title={`${seg.label} · ${formatTotal(seg.ms)}`}
                                        className="w-full rounded-[3px] transition-[filter] duration-150 group-hover/bar:brightness-[1.06]"
                                        style={{
                                            height: `${(seg.ms / max) * 100}%`,
                                            minHeight: 3,
                                            background: seg.color,
                                        }}
                                    />
                                ))
                            )}
                        </div>
                        <div
                            className={cn(
                                'text-[11.5px]',
                                b.labelMuted
                                    ? 'text-muted-foreground/55'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {b.label || ' '}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
