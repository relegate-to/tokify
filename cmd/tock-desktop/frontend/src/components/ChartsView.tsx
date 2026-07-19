import { useMemo } from 'react';

import type { Activity } from '@/types';
import {
    buildDonut,
    buildHourly,
    buildTrend,
    buildWeekdayStacks,
    type DonutSeg,
} from '@/lib/summary';
import { formatTotal } from '@/lib/time';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import {
    Eyebrow,
    Panel,
    ProjectLegend,
    StackedBarChart,
} from '@/components/SummaryBits';

// The donut is drawn on a pathLength=100 circle so each project's share maps
// directly to a stroke-dasharray length; a small gap keeps segments legible.
const GAP = 1.4;

export function ChartsView({ activities }: { activities: Activity[] }) {
    const donut = useMemo(() => buildDonut(activities, 'all'), [activities]);
    const weekday = useMemo(() => buildWeekdayStacks(activities), [activities]);
    const hourly = useMemo(() => buildHourly(activities), [activities]);
    const trend = useMemo(() => buildTrend(activities), [activities]);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between">
                <div className="text-[17px] font-semibold tracking-tight text-foreground">
                    Breakdown
                </div>
                <div className="text-[12.5px] text-muted-foreground/70">past year</div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
                <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
                    <Eyebrow className="mb-4">Project mix</Eyebrow>
                    {donut.segs.length === 0 ? (
                        <EmptyPanel note="Nothing tracked yet." />
                    ) : (
                        <div className="flex items-center gap-5">
                            <div className="relative size-[132px] shrink-0">
                                <svg
                                    viewBox="0 0 42 42"
                                    className="size-[132px] -rotate-90"
                                >
                                    <circle
                                        cx="21"
                                        cy="21"
                                        r="15.915"
                                        fill="none"
                                        stroke="var(--muted)"
                                        strokeWidth="3.6"
                                    />
                                    {donutArcs(donut.segs).map((seg) => (
                                        <circle
                                            key={seg.name}
                                            cx="21"
                                            cy="21"
                                            r="15.915"
                                            fill="none"
                                            pathLength={100}
                                            strokeWidth="3.6"
                                            strokeLinecap="round"
                                            stroke={seg.color}
                                            strokeDasharray={seg.dasharray}
                                            strokeDashoffset={seg.dashoffset}
                                        />
                                    ))}
                                </svg>
                                <div className="absolute inset-0 flex flex-col items-center justify-center">
                                    <div
                                        title={formatTotal(donut.totalMs)}
                                        className="font-mono text-[20px] font-semibold leading-none tabular-nums text-foreground"
                                    >
                                        {donut.totalLabel}
                                    </div>
                                    <div className="mt-1 text-[10.5px] text-muted-foreground/70">
                                        {donut.sub}
                                    </div>
                                </div>
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col gap-3">
                                {donut.segs.map((seg) => (
                                    <div key={seg.name} className="flex items-center gap-2.5">
                                        <span
                                            className="size-2.5 shrink-0 rounded-full"
                                            style={{ background: seg.color }}
                                        />
                                        <div className="flex-1 truncate text-[13px] text-day-total-foreground">
                                            {seg.name}
                                        </div>
                                        <div className="font-mono text-[12.5px] tabular-nums text-muted-foreground">
                                            {seg.pct}%
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </Panel>

                <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 delay-75 duration-500">
                    <div className="mb-3 flex items-baseline justify-between">
                        <Eyebrow>When you work</Eyebrow>
                        <div className="text-[12.5px] text-muted-foreground/70">
                            avg / weekday
                        </div>
                    </div>
                    <StackedBarChart bars={weekday.bars} heightClass="h-[132px]" barMaxWidth={30} />
                </Panel>
            </div>

            <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 delay-100 duration-500">
                <div className="mb-3 flex items-baseline justify-between">
                    <Eyebrow>Time of day</Eyebrow>
                    <div className="text-[12.5px] text-muted-foreground/70">
                        busiest {hourly.peakLabel}
                    </div>
                </div>
                <StackedBarChart
                    bars={hourly.bars}
                    heightClass="h-[84px]"
                    barMaxWidth={16}
                    gapClass="gap-[3px]"
                    pinPeak={false}
                />
            </Panel>

            <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 delay-150 duration-500">
                <div className="mb-3 flex items-baseline justify-between">
                    <Eyebrow>Weekly trend</Eyebrow>
                    <div className="text-[12.5px] text-muted-foreground/70">
                        last 8 weeks · time logged
                    </div>
                </div>
                <StackedBarChart bars={trend.bars} heightClass="h-[96px]" barMaxWidth={44} />
                <div className="mt-4 border-t border-border/60 pt-3.5">
                    <ProjectLegend items={trend.legend} />
                </div>
            </Panel>
        </div>
    );
}

function donutArcs(segs: DonutSeg[]) {
    let cursor = 0;
    return segs.map((seg) => {
        const len = Math.max(0, seg.arcPct - GAP);
        const arc = {
            name: seg.name,
            color: seg.color,
            dasharray: `${len.toFixed(2)} ${(100 - len).toFixed(2)}`,
            dashoffset: (100 - cursor + GAP / 2).toFixed(2),
        };
        cursor += seg.arcPct;
        return arc;
    });
}

function EmptyPanel({ note }: { note: string }) {
    return (
        <Empty className="border-none py-8">
            <EmptyHeader>
                <EmptyTitle>No data yet</EmptyTitle>
                <EmptyDescription>{note}</EmptyDescription>
            </EmptyHeader>
        </Empty>
    );
}
