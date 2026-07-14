import { useMemo } from 'react';

import type { Activity, ActivityView } from '@/types';
import { cn } from '@/lib/utils';
import { groupByLocalDate, startOfDay, totalDuration } from '@/lib/time';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { NowRunning } from '@/components/NowRunning';
import { Starter } from '@/components/Starter';
import { ActivityRow } from '@/components/ActivityRow';
import { DayGroup, DayHeader } from '@/components/DayGroup';
import { AddPastButton } from '@/components/AddPastDialog';

const EARLIER_DAYS = 7;

export function NowView({
    running,
    today,
    recent,
    projects,
    removingKeys,
    activityView,
    onStart,
    onStartAt,
    onStop,
    onShare,
    onUpdate,
    onRemove,
    onResume,
    onAddPast,
}: {
    running: Activity | null;
    today: Activity[];
    recent: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    activityView: ActivityView;
    onStart: (description: string, project: string) => void;
    onStartAt: (description: string, project: string, startISO: string) => void;
    onStop: () => void;
    onShare: (project?: string) => void;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume: (orig: Activity) => void;
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
}) {
    const visibleToday = useMemo(
        () => today.filter((a) => !removingKeys.has(String(a.start_time))),
        [today, removingKeys],
    );
    const todayTotal = useMemo(
        () => totalDuration(visibleToday),
        [visibleToday, running],
    );

    const earlier = useMemo(() => {
        const cutoff =
            startOfDay(new Date()).getTime() - EARLIER_DAYS * 24 * 60 * 60 * 1000;
        const todayStart = startOfDay(new Date()).getTime();
        return recent.filter((a) => {
            const t = new Date(a.start_time as any).getTime();
            return t < todayStart && t >= cutoff;
        });
    }, [recent]);

    const earlierGroups = useMemo(
        () => groupByLocalDate(earlier, false),
        [earlier],
    );

    const lastProject = useMemo(
        () => recent.find((a) => a.project)?.project ?? '',
        [recent],
    );

    // Only show the "nothing tracked yet" illustration when the user is seeing
    // the full activity view and has genuinely never recorded anything — not
    // when they've explicitly hidden earlier days via the 'today' setting.
    const isFullyEmpty =
        !running &&
        activityView === 'all' &&
        visibleToday.length === 0 &&
        earlierGroups.length === 0 &&
        recent.length === 0;

    return (
        <div className="flex flex-1 flex-col gap-8">
            {running ? (
                <NowRunning
                    activity={running}
                    onStop={onStop}
                    onShare={() => onShare(running.project || undefined)}
                />
            ) : (
                <Starter
                    projects={projects}
                    lastProject={lastProject}
                    onStart={onStart}
                    onStartAt={onStartAt}
                />
            )}

            {activityView !== 'none' && !isFullyEmpty && (
            <section aria-label="Today">
                <DayHeader
                    label="Today"
                    day={new Date()}
                    activities={visibleToday}
                    totalMs={todayTotal}
                />
                <div className="relative min-h-11">
                    {today.length > 0 && (
                        <ul className="flex flex-col">
                            {today.map((a) => (
                                <ActivityRow
                                    key={String(a.start_time)}
                                    activity={a}
                                    projects={projects}
                                    isRemoving={removingKeys.has(String(a.start_time))}
                                    onUpdate={onUpdate}
                                    onRemove={onRemove}
                                    onResume={onResume}
                                    readOnly={!a.end_time}
                                />
                            ))}
                        </ul>
                    )}
                    <p
                        className={cn(
                            'pointer-events-none absolute inset-x-0 top-0 flex h-11 items-center px-3 text-sm text-muted-foreground transition-opacity duration-300 ease-out',
                            visibleToday.length === 0
                                ? 'opacity-100'
                                : 'opacity-0',
                        )}
                        aria-hidden={visibleToday.length !== 0}
                    >
                        Nothing tracked today.
                    </p>
                </div>
            </section>
            )}

            {isFullyEmpty && <EmptyDay />}

            {activityView === 'all' && earlierGroups.length > 0 && (
                <section aria-label="Earlier" className="flex flex-col gap-6">
                    {earlierGroups.map((g) => (
                        <DayGroup
                            key={g.dateKey}
                            day={g.date}
                            activities={g.items}
                            projects={projects}
                            removingKeys={removingKeys}
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                            onResume={onResume}
                        />
                    ))}
                </section>
            )}

            {activityView !== 'none' && (
                <AddPastButton projects={projects} onAddPast={onAddPast} />
            )}
        </div>
    );
}

// An empty day track with a marker at the current time — the same motif as
// the day map, inviting the user to put something on it.
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
