import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useCSSVariable } from 'uniwind';

import { SummarySkeleton } from '@/components/Skeletons';
import { Eyebrow, Panel, ProjectLegend, StackedBarChart, useColor } from '@/components/SummaryBits';
import { Text } from '@/components/ui/text';
import { toActivity } from '@/lib/activity';
import { useEntries } from '@/lib/entries';
import { EASE_OUT, enter } from '@/lib/motion';
import { buildDonut, buildHourly, buildTrend, buildWeekdayStacks, type DonutSeg } from '@/lib/summary';

// The desktop's ChartsView. The donut's radius makes its circumference 100,
// so each project's share is directly a dash length.
const GAP = 1.4;
const tabular = { fontVariant: ['tabular-nums' as const] };
const rise = (delay = 0) => enter({ dy: 4, duration: 500, delay, easing: EASE_OUT });

function donutArcs(segs: DonutSeg[]) {
    let cursor = 0;
    return segs.map((seg) => {
        const len = Math.max(0, seg.arcPct - GAP);
        const arc = { name: seg.name, color: seg.color, dasharray: `${len.toFixed(2)} ${(100 - len).toFixed(2)}`, dashoffset: Number((100 - cursor + GAP / 2).toFixed(2)) };
        cursor += seg.arcPct;
        return arc;
    });
}

function Header({ title, note }: { title: string; note: string }) {
    return (
        <View className="mb-3 flex-row items-baseline justify-between">
            <Eyebrow>{title}</Eyebrow>
            <Text className="text-[13px] text-muted-foreground/70">{note}</Text>
        </View>
    );
}

export function ChartsPage() {
    const { entries } = useEntries();
    const color = useColor();
    const muted = String(useCSSVariable('--color-muted') ?? 'transparent');
    const activities = useMemo(() => (entries ?? []).map(toActivity), [entries]);
    const donut = useMemo(() => buildDonut(activities, 'all'), [activities]);
    const weekday = useMemo(() => buildWeekdayStacks(activities), [activities]);
    const hourly = useMemo(() => buildHourly(activities), [activities]);
    const trend = useMemo(() => buildTrend(activities), [activities]);

    if (entries === null) return <SummarySkeleton />;
    return (
        <Animated.View entering={FadeIn.duration(300)} style={{ flex: 1 }}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-4 px-5 pb-10 pt-2">
                <View className="flex-row items-baseline justify-between">
                    <Text className="font-sans-semibold text-[17px] tracking-[-0.3px]">Breakdown</Text>
                    <Text className="text-[13px] text-muted-foreground/70">past year</Text>
                </View>
                <Animated.View entering={rise()}>
                    <Panel>
                        <Eyebrow className="mb-4">Project mix</Eyebrow>
                        {donut.segs.length === 0 ? (
                            <Text className="py-6 text-center text-muted-foreground">Nothing tracked yet.</Text>
                        ) : (
                            <View className="flex-row items-center gap-5">
                                <View className="size-[124px] items-center justify-center">
                                    <Svg viewBox="0 0 42 42" width={124} height={124} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
                                        <Circle cx="21" cy="21" r="15.915" fill="none" stroke={muted} strokeWidth="3.6" />
                                        {donutArcs(donut.segs).map((seg) => (
                                            <Circle
                                                key={seg.name}
                                                cx="21"
                                                cy="21"
                                                r="15.915"
                                                fill="none"
                                                strokeWidth="3.6"
                                                strokeLinecap="round"
                                                stroke={color(seg.color)}
                                                strokeDasharray={seg.dasharray}
                                                strokeDashoffset={seg.dashoffset}
                                            />
                                        ))}
                                    </Svg>
                                    <Text className="font-mono-medium text-[18px] leading-[20px]" style={tabular}>
                                        {donut.totalLabel}
                                    </Text>
                                    <Text className="mt-1 text-[11px] text-muted-foreground/70">{donut.sub}</Text>
                                </View>
                                <View className="min-w-0 flex-1 gap-3">
                                    {donut.segs.map((seg) => (
                                        <View key={seg.name} className="flex-row items-center gap-2.5">
                                            <View className="size-2.5 rounded-full" style={{ backgroundColor: color(seg.color) }} />
                                            <Text numberOfLines={1} className="flex-1 text-sm text-day-total-foreground">
                                                {seg.name}
                                            </Text>
                                            <Text className="font-mono text-[13px] text-muted-foreground" style={tabular}>
                                                {seg.pct}%
                                            </Text>
                                        </View>
                                    ))}
                                </View>
                            </View>
                        )}
                    </Panel>
                </Animated.View>
                <Animated.View entering={rise(75)}>
                    <Panel>
                        <Header title="When you work" note="avg / weekday" />
                        <StackedBarChart bars={weekday.bars} height={132} barMaxWidth={30} />
                    </Panel>
                </Animated.View>
                <Animated.View entering={rise(100)}>
                    <Panel>
                        <Header title="Time of day" note={`busiest ${hourly.peakLabel}`} />
                        <StackedBarChart bars={hourly.bars} height={84} barMaxWidth={16} gap={3} />
                    </Panel>
                </Animated.View>
                <Animated.View entering={rise(150)}>
                    <Panel>
                        <Header title="Weekly trend" note="last 8 weeks · time logged" />
                        <StackedBarChart bars={trend.bars} height={96} barMaxWidth={44} />
                        <View className="mt-4 border-t border-border/60 pt-3.5">
                            <ProjectLegend items={trend.legend} />
                        </View>
                    </Panel>
                </Animated.View>
            </ScrollView>
        </Animated.View>
    );
}
