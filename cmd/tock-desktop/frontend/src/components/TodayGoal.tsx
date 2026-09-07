import { useMemo } from 'react';

import type { Activity } from '@/types';
import { formatTotal } from '@/lib/time';
import { useNow } from '@/lib/use-now';

// Today's tracked time against a daily goal. This strip is the only place goal
// progress appears — the hero and the ledger deliberately stay out of it.
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

    const totalMs = useMemo(() => {
        // The running activity started today, so it's usually already in
        // `activities`; fold it in only when it isn't, and never twice.
        const items = [...activities];
        if (running && !items.some((a) => a.start_time === running.start_time)) {
            items.push(running);
        }

        return items.reduce((sum, a) => {
            const startMs = new Date(a.start_time as any).getTime();
            const endMs = a.end_time
                ? new Date(a.end_time as any).getTime()
                : now;
            return sum + Math.max(0, endMs - startMs);
        }, 0);
    }, [activities, running, now]);

    const pct = goalMs > 0 ? Math.round((totalMs / goalMs) * 100) : 0;
    const remainingMs = Math.max(0, goalMs - totalMs);
    const met = remainingMs === 0;

    return (
        <section
            aria-label="Today's progress"
            className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] border border-border bg-border sm:grid-cols-3"
        >
            <Cell label="Today" value={formatTotal(totalMs)} />
            <Cell
                label={`Of ${formatTotal(goalMs)} goal`}
                value={`${pct}%`}
                gap="gap-2.5"
            >
                <div className="h-[3px] overflow-hidden rounded-[2px] bg-navigation">
                    <div
                        className="h-full bg-goal-accent transition-[width] duration-500 ease-out"
                        style={{ width: `${Math.min(100, pct)}%` }}
                    />
                </div>
            </Cell>
            <Cell
                label="Remaining"
                value={met ? 'Goal met' : formatTotal(remainingMs)}
            />
        </section>
    );
}

function Cell({
    label,
    value,
    gap = 'gap-[5px]',
    children,
}: {
    label: string;
    value: string;
    gap?: string;
    children?: React.ReactNode;
}) {
    return (
        <div className={`flex flex-col bg-card px-[22px] py-5 ${gap}`}>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-navigation-muted-foreground">
                {label}
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-[-0.02em] text-foreground">
                {value}
            </span>
            {children}
        </div>
    );
}
