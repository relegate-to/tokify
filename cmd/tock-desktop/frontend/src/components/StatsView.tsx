import { useMemo } from 'react';
import { CalendarRange, Hourglass, Sun } from 'lucide-react';

import type { Activity } from '@/types';
import { buildStats, type RecordRow } from '@/lib/summary';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Band, Eyebrow, Panel } from '@/components/SummaryBits';

// Streak squares reuse the ContributionGraph's language: the day's dominant
// project supplies the hue, intensity supplies the opacity.
const DOT_OPACITY = [0, 0.34, 0.52, 0.72, 0.95];

const RECORD_ICONS = {
    session: Hourglass,
    day: Sun,
    week: CalendarRange,
} as const;

export function StatsView({ activities }: { activities: Activity[] }) {
    const stats = useMemo(() => buildStats(activities), [activities]);

    if (stats.empty) {
        return (
            <Empty className="min-h-[360px]">
                <EmptyHeader>
                    <EmptyTitle>No stats yet</EmptyTitle>
                    <EmptyDescription>
                        Track a few sessions and your streaks, averages, and
                        records will show up here.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <Band className="animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
                <div className="mb-5 flex items-start justify-between gap-6">
                    <div>
                        <Eyebrow className="mb-3">Current streak</Eyebrow>
                        <div className="flex items-baseline gap-2.5">
                            <div className="font-mono text-[42px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-foreground">
                                {stats.currentStreak}
                            </div>
                            <div className="text-[15px] text-muted-foreground">
                                {stats.currentStreak === 1 ? 'day' : 'days'}
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="font-mono text-lg font-semibold leading-none tabular-nums text-day-total-foreground">
                            {stats.longestStreak}
                        </div>
                        <div className="mt-1.5 text-xs text-muted-foreground/80">
                            longest streak
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    {stats.dots.map((d, i) => (
                        <div
                            key={i}
                            title={`${d.label} · ${d.tracked ? 'tracked' : 'no activity'}`}
                            className="h-[26px] flex-1 rounded-[5px]"
                            style={
                                d.tracked
                                    ? {
                                          background: d.color,
                                          opacity: DOT_OPACITY[d.level],
                                      }
                                    : { background: 'var(--muted)' }
                            }
                        />
                    ))}
                </div>
                <div className="mt-2.5 flex items-center justify-between text-[11.5px] text-muted-foreground/70">
                    <div>{stats.rangeStart}</div>
                    <div>Today</div>
                </div>
            </Band>

            <div className="grid grid-cols-3 gap-3">
                {stats.cards.map((c, i) => (
                    <div
                        key={c.label}
                        className="animate-in fade-in-0 slide-in-from-bottom-1 rounded-2xl bg-card p-5 ring-1 ring-foreground/10 transition-[transform,box-shadow] duration-500 hover:-translate-y-0.5 hover:shadow-[0_12px_26px_-14px_rgba(17,19,24,0.28)]"
                        style={{ animationDelay: `${i * 40}ms` }}
                    >
                        <div className="mb-3 flex items-center gap-2">
                            {c.accent && (
                                <span
                                    className="size-2 rounded-full"
                                    style={{ background: c.accent }}
                                />
                            )}
                            <Eyebrow>{c.label}</Eyebrow>
                        </div>
                        <div className="font-mono text-[27px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-foreground">
                            {c.value}
                        </div>
                        <div className="mt-2 text-[12.5px] text-muted-foreground/80">
                            {c.sub}
                        </div>
                    </div>
                ))}
            </div>

            <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 py-2 delay-150 duration-500">
                {stats.records.map((r, i) => (
                    <RecordItem
                        key={r.label}
                        record={r}
                        last={i === stats.records.length - 1}
                    />
                ))}
            </Panel>
        </div>
    );
}

function RecordItem({ record, last }: { record: RecordRow; last: boolean }) {
    const Icon = RECORD_ICONS[record.icon];
    return (
        <div
            className={
                last
                    ? 'flex items-center justify-between py-3.5'
                    : 'flex items-center justify-between border-b border-border/60 py-3.5'
            }
        >
            <div className="flex items-center gap-3">
                <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                    <Icon className="size-[15px]" />
                </div>
                <div className="text-sm text-day-total-foreground">
                    {record.label}
                </div>
            </div>
            <div className="flex items-baseline gap-2.5">
                <div className="font-mono text-[14.5px] font-semibold tabular-nums text-foreground">
                    {record.value}
                </div>
                <div className="w-[92px] text-right text-xs tabular-nums text-muted-foreground/70">
                    {record.when}
                </div>
            </div>
        </div>
    );
}
