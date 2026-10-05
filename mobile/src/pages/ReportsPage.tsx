import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { SummarySkeleton } from '@/components/Skeletons';
import { Band, Eyebrow, MixRibbon, Panel, Segmented, StackedBarChart, useColor } from '@/components/SummaryBits';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toActivity } from '@/lib/activity';
import { useEntries } from '@/lib/entries';
import { EASE_OUT, enter } from '@/lib/motion';
import { buildReport } from '@/lib/summary';
import { formatTotal } from '@/lib/time';
import { cn } from '@/lib/utils';

// The desktop's ReportsView: a week or month at a time, stepping back through
// history, with the headline total, its project mix and the top tasks.
const tabular = { fontVariant: ['tabular-nums' as const] };
const rise = (delay = 0) => enter({ dy: 4, duration: 500, delay, easing: EASE_OUT });

export function ReportsPage() {
    const { entries } = useEntries();
    const color = useColor();
    const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
    const [offset, setOffset] = useState(0);
    const activities = useMemo(() => (entries ?? []).map(toActivity), [entries]);
    const rep = useMemo(() => buildReport(activities, period, offset), [activities, period, offset]);

    if (entries === null) return <SummarySkeleton />;
    return (
        <Animated.View entering={FadeIn.duration(300)} style={{ flex: 1 }}>
            <ScrollView contentContainerClassName="gap-4 px-5 pb-10 pt-2">
                <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-1">
                        <StepButton onPress={() => setOffset((o) => o - 1)} label="Previous period" icon={ChevronLeft} />
                        <Text className="min-w-[116px] text-center font-sans-semibold text-[16px] tracking-[-0.3px]">{rep.periodLabel}</Text>
                        <StepButton onPress={() => setOffset((o) => Math.min(0, o + 1))} disabled={offset >= 0} label="Next period" icon={ChevronRight} />
                    </View>
                    <Segmented
                        value={period}
                        onChange={(p) => {
                            setPeriod(p);
                            setOffset(0);
                        }}
                        options={[
                            { value: 'weekly', label: 'Weekly' },
                            { value: 'monthly', label: 'Monthly' },
                        ]}
                    />
                </View>
                <Animated.View entering={rise()}>
                    <Band>
                        <View className="mb-3 gap-4">
                            <View>
                                <Eyebrow className="mb-2">{rep.eyebrow}</Eyebrow>
                                <Text className="font-mono-medium text-[34px] leading-[38px] tracking-[-0.4px]" style={tabular}>
                                    {formatTotal(rep.totalMs)}
                                </Text>
                                {rep.hasPrev ? (
                                    <View className="mt-1.5 flex-row items-center gap-1">
                                        <Icon as={rep.up ? ArrowUpRight : ArrowDownRight} className="size-3.5 text-muted-foreground" />
                                        <Text className="font-sans-medium text-[13px] text-day-total-foreground" style={tabular}>
                                            {rep.up ? '+' : '−'}
                                            {formatTotal(Math.abs(rep.deltaMs))}
                                            <Text className="text-[13px] text-muted-foreground/70">
                                                {' '}
                                                · {rep.up ? '+' : '−'}
                                                {Math.abs(rep.deltaPct)}% vs prev
                                            </Text>
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                            <View className="flex-row items-stretch gap-6">
                                <SummaryStat value={formatTotal(rep.avgMs)} label={rep.avgSub} />
                                <View className="w-px bg-border" />
                                <SummaryStat value={rep.trackedLabel} label="days tracked" />
                            </View>
                        </View>
                        <MixRibbon mix={rep.mix} total={rep.totalMs} />
                        <View className="mt-4">
                            <StackedBarChart bars={rep.bars} height={104} barMaxWidth={34} />
                        </View>
                    </Band>
                </Animated.View>
                <Animated.View entering={rise(75)}>
                    <Panel>
                        <View className="mb-3 flex-row items-baseline justify-between">
                            <Eyebrow>By project</Eyebrow>
                            <Text className="text-[13px] text-muted-foreground/70" style={tabular}>
                                {rep.projects.length} {rep.projects.length === 1 ? 'project' : 'projects'} · {formatTotal(rep.projectTotalMs)}
                            </Text>
                        </View>
                        {rep.projects.length === 0 ? (
                            <View className="items-center gap-1 py-6">
                                <Text className="font-sans-semibold">Nothing tracked this {period === 'weekly' ? 'week' : 'month'}</Text>
                                <Text className="text-muted-foreground">Track some time and it'll break down here.</Text>
                            </View>
                        ) : (
                            rep.projects.map((p) => (
                                <View key={p.name} className="flex-row items-center gap-3 py-2.5">
                                    <View className="size-2.5 rounded-full" style={{ backgroundColor: color(p.color) }} />
                                    <Text numberOfLines={1} className="w-24 font-sans-medium text-[15px]">
                                        {p.name}
                                    </Text>
                                    <View className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                        <View className="h-full rounded-full" style={{ width: `${p.barPct}%`, backgroundColor: color(p.color) }} />
                                    </View>
                                    <Text className="w-14 text-right font-mono-medium text-sm text-day-total-foreground" style={tabular}>
                                        {formatTotal(p.ms)}
                                    </Text>
                                </View>
                            ))
                        )}
                    </Panel>
                </Animated.View>
                {rep.tasks.length > 0 ? (
                    <Animated.View entering={rise(100)}>
                        <Panel>
                            <View className="mb-3 flex-row items-baseline justify-between">
                                <Eyebrow>Most worked on</Eyebrow>
                                <Text className="text-[13px] text-muted-foreground/70">top {rep.tasks.length === 1 ? 'task' : 'tasks'}</Text>
                            </View>
                            {rep.tasks.map((t) => (
                                <View key={t.title} className="flex-row items-center gap-3 py-2.5">
                                    <View className="size-2.5 rounded-full" style={{ backgroundColor: color(t.color) }} />
                                    <View className="min-w-0 flex-1">
                                        <Text numberOfLines={1} className="font-sans-medium text-[15px]">
                                            {t.title}
                                        </Text>
                                        <Text numberOfLines={1} className="mt-0.5 text-[13px] text-muted-foreground">
                                            {t.project} · {t.sessions} {t.sessions === 1 ? 'session' : 'sessions'}
                                        </Text>
                                    </View>
                                    <Text className="font-mono-medium text-sm text-day-total-foreground" style={tabular}>
                                        {formatTotal(t.ms)}
                                    </Text>
                                </View>
                            ))}
                        </Panel>
                    </Animated.View>
                ) : null}
            </ScrollView>
        </Animated.View>
    );
}

function StepButton({ onPress, disabled, label, icon }: { onPress: () => void; disabled?: boolean; label: string; icon: typeof ChevronLeft }) {
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityLabel={label}
            accessibilityRole="button"
            className={cn('size-9 items-center justify-center rounded-lg active:bg-accent', disabled && 'opacity-25')}
        >
            <Icon as={icon} className="size-[18px] text-muted-foreground" />
        </Pressable>
    );
}

function SummaryStat({ value, label }: { value: string; label: string }) {
    return (
        <View>
            <Text className="font-mono-medium text-lg leading-[20px] text-day-total-foreground" style={tabular}>
                {value}
            </Text>
            <Text className="mt-1.5 text-xs text-muted-foreground/80">{label}</Text>
        </View>
    );
}
