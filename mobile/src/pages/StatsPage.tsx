import { CalendarRange, Hourglass, Sun } from 'lucide-react-native';
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { SummarySkeleton } from '@/components/Skeletons';
import { Band, Eyebrow, Panel, useColor } from '@/components/SummaryBits';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toActivity } from '@/lib/activity';
import { useEntries } from '@/lib/entries';
import { EASE_OUT, enter } from '@/lib/motion';
import { buildStats, type RecordRow } from '@/lib/summary';
import { cn } from '@/lib/utils';

// The desktop's StatsView: streaks, averages and records.
const DOT_OPACITY = [0, 0.34, 0.52, 0.72, 0.95];
const RECORD_ICONS = { session: Hourglass, day: Sun, week: CalendarRange } as const;
const tabular = { fontVariant: ['tabular-nums' as const] };
// The desktop's fade-in-0 slide-in-from-bottom-1 duration-500, with its
// per-card stagger.
function rise(delay = 0) {
    return enter({ dy: 4, duration: 500, delay, easing: EASE_OUT });
}

export function StatsPage() {
    const { entries } = useEntries();
    const color = useColor();
    const stats = useMemo(() => buildStats((entries ?? []).map(toActivity)), [entries]);

    if (stats.empty) {
        return (
            <View className="flex-1 items-center justify-center gap-2 px-10">
                <Text className="font-sans-semibold text-base">No stats yet</Text>
                <Text className="text-center text-muted-foreground">Track a few sessions and your streaks, averages, and records will show up here.</Text>
            </View>
        );
    }

    if (entries === null) return <SummarySkeleton />;
    return (
        <Animated.View entering={FadeIn.duration(300)} style={{ flex: 1 }}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-3 px-5 pb-10 pt-2">
                <Animated.View entering={rise()}>
                    <Band>
                        <View className="mb-5 flex-row items-start justify-between gap-6">
                            <View>
                                <Eyebrow className="mb-3">Current streak</Eyebrow>
                                <View className="flex-row items-baseline gap-2.5">
                                    <Text className="font-mono-medium text-[34px] leading-[38px] tracking-[-0.3px]" style={tabular}>
                                        {stats.currentStreak}
                                    </Text>
                                    <Text className="text-[15px] text-muted-foreground">{stats.currentStreak === 1 ? 'day' : 'days'}</Text>
                                </View>
                            </View>
                            <View className="items-end">
                                <Text className="font-mono-medium text-lg text-day-total-foreground" style={tabular}>
                                    {stats.longestStreak}
                                </Text>
                                <Text className="mt-1.5 text-xs text-muted-foreground/80">longest streak</Text>
                            </View>
                        </View>
                        <View className="flex-row items-center gap-1.5">
                            {stats.dots.map((d, i) => (
                                <View
                                    key={i}
                                    className={cn('h-[26px] flex-1 rounded-[5px]', !d.tracked && 'bg-muted')}
                                    style={d.tracked ? { backgroundColor: color(d.color), opacity: DOT_OPACITY[d.level] } : undefined}
                                />
                            ))}
                        </View>
                        <View className="mt-2.5 flex-row justify-between">
                            <Text className="text-xs text-muted-foreground/70">{stats.rangeStart}</Text>
                            <Text className="text-xs text-muted-foreground/70">Today</Text>
                        </View>
                    </Band>
                </Animated.View>
                <View className="flex-row flex-wrap gap-3">
                    {stats.cards.map((c, i) => (
                        <Animated.View key={c.label} entering={rise(i * 40)} style={{ width: '48.4%' }}>
                            <View className="rounded-2xl border border-foreground/10 bg-card p-4">
                                <View className="mb-3 flex-row items-center gap-2">
                                    {c.accent ? <View className="size-2 rounded-full" style={{ backgroundColor: color(c.accent) }} /> : null}
                                    <Eyebrow>{c.label}</Eyebrow>
                                </View>
                                <Text className="font-mono-medium text-[22px] leading-[24px]" style={tabular}>
                                    {c.value}
                                </Text>
                                <Text className="mt-2 text-[13px] text-muted-foreground/80">{c.sub}</Text>
                            </View>
                        </Animated.View>
                    ))}
                </View>
                <Animated.View entering={rise(150)}>
                    <Panel className="py-1">
                        {stats.records.map((r, i) => (
                            <RecordItem key={r.label} record={r} last={i === stats.records.length - 1} />
                        ))}
                    </Panel>
                </Animated.View>
            </ScrollView>
        </Animated.View>
    );
}

function RecordItem({ record, last }: { record: RecordRow; last: boolean }) {
    return (
        <View className={cn('flex-row items-center justify-between py-3.5', !last && 'border-b border-border/60')}>
            <View className="flex-row items-center gap-3">
                <View className="size-[30px] items-center justify-center rounded-lg bg-secondary">
                    <Icon as={RECORD_ICONS[record.icon]} className="size-[15px] text-muted-foreground" />
                </View>
                <Text className="text-[15px] text-day-total-foreground">{record.label}</Text>
            </View>
            <View className="items-end">
                <Text className="font-mono-medium text-[15px]" style={tabular}>
                    {record.value}
                </Text>
                <Text className="text-xs text-muted-foreground/70" style={tabular}>
                    {record.when}
                </Text>
            </View>
        </View>
    );
}
