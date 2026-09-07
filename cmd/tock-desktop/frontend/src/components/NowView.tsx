import { useMemo } from 'react';

import type { Activity, ActivityView } from '@/types';
import { dayLabel, startOfDay } from '@/lib/time';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { NowRunning } from '@/components/NowRunning';
import { Starter } from '@/components/Starter';
import { TodayGoal } from '@/components/TodayGoal';
import { JumpBackIn } from '@/components/JumpBackIn';

const QUICK_START_COUNT = 4;

function quickStartKey(activity: Activity) {
    return JSON.stringify([
        activity.description ?? '',
        activity.project ?? '',
    ]);
}

export function NowView({
    running,
    today,
    recent,
    projects,
    removingKeys,
    activityView,
    dailyGoal,
    onStart,
    onStartAt,
    onStop,
    onShare,
    onResume,
    onUpdate,
    onRemove,
}: {
    running: Activity | null;
    today: Activity[];
    recent: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    activityView: ActivityView;
    dailyGoal: number;
    onStart: (description: string, project: string) => void;
    onStartAt: (description: string, project: string, startISO: string) => void;
    onStop: () => void;
    onShare: (project?: string) => void;
    onResume: (orig: Activity) => void;
    onUpdate: (
        orig: Activity,
        description: string,
        project: string,
        startISO: string,
        endISO: string,
    ) => void;
    onRemove: (orig: Activity) => void;
}) {
    const visibleToday = useMemo(
        () => today.filter((a) => !removingKeys.has(String(a.start_time))),
        [today, removingKeys],
    );

    const quickStarts = useMemo(() => {
        const runningKey = running ? quickStartKey(running) : null;
        const seen = new Set<string>();
        const out: Activity[] = [];

        for (const activity of recent) {
            if (!activity.description || !activity.end_time) continue;

            const key = quickStartKey(activity);
            if (key === runningKey || seen.has(key)) continue;

            seen.add(key);
            out.push(activity);
            if (out.length >= QUICK_START_COUNT) break;
        }

        return out;
    }, [recent, removingKeys, running]);

    const contextLabel = useMemo(() => {
        if (quickStarts.length === 0) return '';

        const labels = new Set(
            quickStarts.map((activity) =>
                dayLabel(startOfDay(new Date(activity.start_time as any))),
            ),
        );
        return labels.size === 1 ? [...labels][0] : 'Recent';
    }, [quickStarts]);

    // Idle status line: when the last session ended, across today and the wider
    // recent window (a fresh morning has no rows in `today` yet).
    const lastStop = useMemo(() => {
        let latest = 0;
        for (const a of [...today, ...recent]) {
            if (!a.end_time) continue;
            if (removingKeys.has(String(a.start_time))) continue;
            const end = new Date(a.end_time as any).getTime();
            if (end > latest) latest = end;
        }
        return latest > 0 ? new Date(latest) : null;
    }, [today, recent, removingKeys]);

    // The idle hero opens on the project you last tracked against, so starting
    // another entry in the same project takes one keystroke.
    const defaultProject = useMemo(() => {
        let latest = 0;
        let project = '';
        for (const a of [...today, ...recent]) {
            if (!a.project) continue;
            const start = new Date(a.start_time as any).getTime();
            if (start > latest) {
                latest = start;
                project = a.project;
            }
        }
        return project;
    }, [today, recent]);

    const hasHistory = recent.length > 0;
    const isColdStart = !running && visibleToday.length === 0 && !hasHistory;
    const showSummary = activityView !== 'none' && !isColdStart;
    const showJumpBack = activityView === 'all' && quickStarts.length > 0;

    return (
        <div className="relative mx-auto flex min-h-full w-full max-w-[1020px] flex-1 flex-col gap-[34px]">
            {running ? (
                <NowRunning activity={running} onStop={onStop} />
            ) : (
                <Starter
                    projects={projects}
                    lastStop={lastStop}
                    defaultProject={defaultProject}
                    onStart={onStart}
                    onStartAt={onStartAt}
                />
            )}

            {showSummary && (
                <TodayGoal
                    activities={visibleToday}
                    running={running}
                    goalMinutes={dailyGoal}
                />
            )}

            {showJumpBack && (
                <JumpBackIn
                    items={quickStarts}
                    contextLabel={contextLabel}
                    projects={projects}
                    removingKeys={removingKeys}
                    onResume={onResume}
                    onUpdate={onUpdate}
                    onRemove={onRemove}
                />
            )}

            {isColdStart && <EmptyDay />}
        </div>
    );
}

function EmptyDay() {
    const nowPct =
        ((Date.now() - startOfDay(new Date()).getTime()) /
            (24 * 60 * 60 * 1000)) *
        100;

    return (
        <Empty className="flex-none border-none p-0 animate-in fade-in-0 duration-500">
            <EmptyHeader>
                <EmptyMedia className="w-44">
                    <div
                        aria-hidden
                        className="relative h-1 w-full rounded-full bg-border/60"
                    >
                        <span
                            className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
                            style={{ left: `${nowPct}%` }}
                        >
                            <span className="absolute inset-0 animate-ping rounded-full bg-foreground/40 [animation-duration:3s] motion-reduce:hidden" />
                        </span>
                    </div>
                </EmptyMedia>
                <EmptyTitle>Nothing tracked yet</EmptyTitle>
                <EmptyDescription>
                    The dot is now. Type what you're working on above and press
                    Enter to start the clock.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    );
}
