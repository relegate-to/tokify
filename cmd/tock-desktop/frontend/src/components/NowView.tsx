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
            if (removingKeys.has(String(activity.start_time))) continue;
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

    const hasHistory = recent.length > 0;
    const isColdStart = !running && visibleToday.length === 0 && !hasHistory;
    const showSummary = activityView !== 'none' && !isColdStart;
    const showJumpBack = activityView === 'all' && quickStarts.length > 0;

    return (
        <div className="relative flex min-h-full flex-1 flex-col gap-8">
            <div>
                <SectionHeading
                    title={running ? 'Currently tracking' : 'Start tracking'}
                />
                {running ? (
                    <NowRunning
                        activity={running}
                        onStop={onStop}
                        onShare={() => onShare(running.project || undefined)}
                    />
                ) : (
                    <Starter
                        projects={projects}
                        onStart={onStart}
                        onStartAt={onStartAt}
                    />
                )}
            </div>

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
                    onResume={onResume}
                />
            )}

            {isColdStart && <EmptyDay />}
        </div>
    );
}

// Section heading matching JumpBackIn, so the activity page reads as a set of
// titled sections rather than a loose stack of cards.
function SectionHeading({ title, context }: { title: string; context?: string }) {
    return (
        <div className="mb-3.5 flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
            {context && (
                <span className="text-xs text-navigation-muted-foreground">
                    {context}
                </span>
            )}
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
