import { useState } from 'react';
import { Square } from 'lucide-react';

import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { EASE_OUT, EASE_THUNK } from '@/lib/motion';
import { formatClock, formatDuration } from '@/lib/time';
import { Button } from '@/components/ui/button';
import { ProjectTag } from '@/components/ProjectTag';

const STOP_ANIM_MS = 380;

export function NowRunning({
    activity,
    onStop,
    prominent = false,
}: {
    activity: Activity;
    onStop: () => void;
    prominent?: boolean;
}) {
    const since = new Date(activity.start_time as any);
    const ms = Date.now() - since.getTime();
    const seconds = Math.floor(ms / 1000) % 60;
    const minutePct = (seconds / 60) * 100;
    const [stopping, setStopping] = useState(false);

    const handleStop = () => {
        if (stopping) return;
        setStopping(true);
        window.setTimeout(onStop, STOP_ANIM_MS);
    };

    return (
        <section
            aria-label="Currently running"
            className={cn(
                'relative overflow-hidden rounded-xl border bg-card shadow-sm transition-[padding] duration-300 ease-out',
                prominent ? 'px-8 py-16' : 'p-6',
                stopping
                    ? 'animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards'
                    : 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-6',
            )}
            style={{
                animationDuration: stopping ? `${STOP_ANIM_MS}ms` : '520ms',
                animationTimingFunction: stopping ? EASE_OUT : EASE_THUNK,
            }}
        >
            {prominent ? (
                <div className="flex flex-col items-center gap-6 text-center">
                    {activity.project && (
                        <ProjectTag project={activity.project} className="max-w-48" />
                    )}
                    <p className="max-w-md truncate text-xl font-medium leading-snug">
                        {activity.description || 'No description'}
                    </p>
                    <div
                        className="font-mono text-6xl leading-none tabular-nums"
                        aria-live="polite"
                    >
                        {formatDuration(ms)}
                    </div>
                    <span className="text-xs text-muted-foreground">
                        since {formatClock(since)}
                    </span>
                    <Button
                        onClick={handleStop}
                        variant="destructive"
                        size="sm"
                        disabled={stopping}
                        className="mt-2 transition-transform active:scale-95"
                    >
                        <Square data-icon="inline-start" /> Stop
                    </Button>
                </div>
            ) : (
                <>
                    <div className="flex items-baseline justify-between gap-4">
                        <p className="min-w-0 flex-1 truncate text-xl font-medium leading-snug">
                            {activity.description || 'No description'}
                        </p>
                        <div
                            className="font-mono text-2xl leading-none tabular-nums"
                            aria-live="polite"
                        >
                            {formatDuration(ms)}
                        </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                            {activity.project && (
                                <ProjectTag
                                    project={activity.project}
                                    className="max-w-40"
                                />
                            )}
                            <span className="text-xs text-muted-foreground">
                                since {formatClock(since)}
                            </span>
                        </div>
                        <Button
                            onClick={handleStop}
                            variant="destructive"
                            size="sm"
                            disabled={stopping}
                            className="transition-transform active:scale-95"
                        >
                            <Square data-icon="inline-start" /> Stop
                        </Button>
                    </div>
                </>
            )}
            <div
                className={cn(
                    'absolute bottom-0 left-0 h-0.5 bg-foreground transition-[width] ease-linear',
                    stopping ? 'duration-300' : 'duration-1000',
                )}
                style={{
                    width: stopping ? '100%' : `${minutePct}%`,
                    backgroundColor: activity.project
                        ? projectColor(activity.project)
                        : undefined,
                }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={60}
                aria-valuenow={seconds}
                aria-label="Progress through current minute"
            />
        </section>
    );
}
