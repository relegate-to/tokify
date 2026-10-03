import { useCallback, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useCSSVariable } from 'uniwind';

import { Text } from '@/components/ui/text';
import type { LegendItem, Seg, StackBar } from '@/lib/summary';
import { formatTotal } from '@/lib/time';
import { cn } from '@/lib/utils';

// The desktop's SummaryBits: a soft anchor band for the headline number, plain
// card panels for the detail below, and the project-coloured bars and legends
// the Reports, Charts and Stats views share.

const PROJECT_VARS = Array.from({ length: 8 }, (_, i) => `--color-project-${i}`);

// summary.ts colours are theme variable names; this resolves them for the
// current theme.
export function useColor() {
    const palette = useCSSVariable(PROJECT_VARS);
    return useCallback(
        (name: string) => {
            const i = PROJECT_VARS.indexOf(name);
            return i >= 0 ? String(palette[i] ?? 'transparent') : 'transparent';
        },
        [palette],
    );
}

export function Band({ className, children }: { className?: string; children: ReactNode }) {
    return <View className={cn('rounded-2xl border border-subtle-surface-border bg-subtle-surface p-4', className)}>{children}</View>;
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
    return <View className={cn('rounded-2xl border border-foreground/10 bg-card p-4', className)}>{children}</View>;
}

export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
    return <Text className={cn('font-sans-semibold text-xs uppercase tracking-[1px] text-muted-foreground/80', className)}>{children}</Text>;
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
    return (
        <View className="flex-row items-center gap-0.5 self-start rounded-lg bg-navigation p-[3px]">
            {options.map((o) => {
                const active = o.value === value;
                return (
                    <Pressable
                        key={o.value}
                        onPress={() => onChange(o.value)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: active }}
                        className={cn('rounded-md px-3.5 py-2', active && 'bg-navigation-active shadow-sm shadow-black/10')}
                    >
                        <Text className={cn('text-sm', active ? 'font-sans-semibold text-navigation-active-foreground' : 'font-sans-medium text-navigation-muted-foreground')}>
                            {o.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

// The period's project mix as one horizontal bar.
export function MixRibbon({ mix, total }: { mix: Seg[]; total: number }) {
    const color = useColor();
    if (total <= 0 || mix.length === 0) return <View className="h-2 rounded-full bg-muted" />;
    return (
        <View className="h-2 flex-row items-stretch gap-[3px]">
            {mix.map((seg) => (
                <View key={seg.project} className="min-w-[3px] rounded-full" style={{ width: `${(seg.ms / total) * 100}%`, backgroundColor: color(seg.color) }} />
            ))}
        </View>
    );
}

export function ProjectLegend({ items, className }: { items: LegendItem[]; className?: string }) {
    const color = useColor();
    if (items.length === 0) return null;
    return (
        <View className={cn('flex-row flex-wrap items-center gap-x-4 gap-y-2', className)}>
            {items.map((it) => (
                <View key={it.name} className="flex-row items-center gap-1.5">
                    <View className="size-2 rounded-full" style={{ backgroundColor: color(it.color) }} />
                    <Text className="text-[13px] text-muted-foreground">{it.name}</Text>
                </View>
            ))}
        </View>
    );
}

// Columns stacked from project-coloured segments. With no hover on a phone,
// the peak's value is always pinned and the rest stay unlabelled.
export function StackedBarChart({ bars, height = 136, barMaxWidth = 30, gap = 10 }: { bars: StackBar[]; height?: number; barMaxWidth?: number; gap?: number }) {
    const color = useColor();
    const max = Math.max(...bars.map((b) => b.total), 1);
    const peak = bars.reduce((best, b, i) => (b.total > bars[best].total ? i : best), 0);
    return (
        <View className="flex-row items-end" style={{ height, gap }}>
            {bars.map((b, i) => {
                const showValue = b.pinned || (i === peak && b.total > 0);
                return (
                    <View key={`${b.label}-${i}`} className="h-full min-w-0 flex-1 items-center justify-end gap-2">
                        <Text className={cn('h-4 font-mono text-[11px] leading-4 text-muted-foreground', !showValue && 'opacity-0')} numberOfLines={1}>
                            {b.total > 0 ? formatTotal(b.total) : '—'}
                        </Text>
                        <View className="w-[64%] flex-1 justify-end" style={{ maxWidth: barMaxWidth }}>
                            {b.segments.length === 0 ? (
                                <View className="h-[3px] rounded-full bg-muted" />
                            ) : (
                                <View className="flex-col-reverse gap-px overflow-hidden rounded-[3px]" style={{ height: `${(b.total / max) * 100}%`, minHeight: 3 }}>
                                    {b.segments.map((seg) => (
                                        <View key={seg.project} style={{ flexGrow: seg.ms, flexBasis: 0, minHeight: 3, backgroundColor: color(seg.color) }} />
                                    ))}
                                </View>
                            )}
                        </View>
                        <Text numberOfLines={1} className={cn('h-4 text-xs leading-4', b.labelMuted ? 'text-muted-foreground/55' : 'text-muted-foreground')}>
                            {b.label}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
}
