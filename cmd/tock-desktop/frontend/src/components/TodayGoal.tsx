import { useMemo } from 'react';

import type { Activity } from '@/types';
import { projectColor } from '@/lib/colors';
import { formatTotal } from '@/lib/time';
import { useNow } from '@/lib/use-now';

type Segment = {
    key: string;
    label: string;
    color: string;
    ms: number;
    widthPct: number;
};

// Today's tracked time against a daily goal — a lightweight pacing signal the
// Log tab can't give you. The bar is segmented by project; segments live-grow
// while an activity is running.
export function TodayGoal({
    activities,
    running,
    goalMinutes,
}: {
    activities: Activity[];
    running: Activity | null;
    goalMinutes: number;
}) {
    const now = useNow(!!running);
    const goalMs = goalMinutes * 60_000;

    const { totalMs, segments } = useMemo(() => {
        // The running activity started today, so it's usually already in
        // `activities`; fold it in only when it isn't, and never twice.
        const items = [...activities];
        if (running && !items.some((a) => a.start_time === running.start_time)) {
            items.push(running);
        }

        const order: string[] = [];
        const byProject = new Map<string, number>();
        for (const a of items) {
            const startMs = new Date(a.start_time as any).getTime();
            const endMs = a.end_time
                ? new Date(a.end_time as any).getTime()
                : now;
            const dur = Math.max(0, endMs - startMs);
            const key = a.project || '';
            if (!byProject.has(key)) order.push(key);
            byProject.set(key, (byProject.get(key) ?? 0) + dur);
        }

        const segs: Segment[] = order.map((key) => {
            const ms = byProject.get(key) ?? 0;
            return {
                key,
                label: key || 'No project',
                color: projectColor(key),
                ms,
                widthPct: goalMs > 0 ? (ms / goalMs) * 100 : 0,
            };
        });
        const total = segs.reduce((sum, s) => sum + s.ms, 0);
        return { totalMs: total, segments: segs };
    }, [activities, running, now, goalMs]);

    const pct = goalMs > 0 ? Math.round((totalMs / goalMs) * 100) : 0;
    const remainingMs = Math.max(0, goalMs - totalMs);

    return (
        <section
            aria-label="Today's progress"
            className="rounded-2xl border border-subtle-surface-border bg-subtle-surface px-6 py-5"
        >
            <div className="mb-[18px] flex items-end justify-between gap-4">
                <div>
                    <div className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.05em] text-navigation-muted-foreground">
                        Today
                    </div>
                    <div className="flex items-baseline gap-2.5">
                        <span className="font-mono text-[19px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-foreground">
                            {formatTotal(totalMs)}
                        </span>
                        <span className="text-[13px] text-muted-foreground">
                            of {formatTotal(goalMs)} goal
                        </span>
                    </div>
                </div>
                <div className="text-right">
                    <div className="font-mono text-[15px] font-semibold leading-none tabular-nums text-muted-foreground">
                        {pct}%
                    </div>
                    <div className="mt-1.5 text-xs text-navigation-muted-foreground">
                        {remainingMs > 0
                            ? `${formatTotal(remainingMs)} to goal`
                            : 'Goal reached'}
                    </div>
                </div>
            </div>

            <div className="flex h-2 overflow-hidden rounded-full bg-border">
                {segments.map((seg) => (
                    <div
                        key={seg.key}
                        style={{
                            width: `${seg.widthPct}%`,
                            backgroundColor: seg.color,
                        }}
                        className="h-full transition-[width] duration-500 ease-out"
                    />
                ))}
            </div>

            {segments.length > 0 && (
                <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2">
                    {segments.map((seg) => (
                        <div key={seg.key} className="flex items-center gap-2">
                            <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: seg.color }}
                            />
                            <span className="text-xs text-day-total-foreground">
                                {seg.label}
                            </span>
                            <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
                                {formatTotal(seg.ms)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
