import { useState, type CSSProperties } from 'react';
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
    const accent = activity.project ? projectColor(activity.project) : '#f5c451';

    const handleStop = () => {
        if (stopping) return;
        setStopping(true);
        window.setTimeout(onStop, STOP_ANIM_MS);
    };

    return (
        <section
            aria-label="Currently running"
            className={cn(
                'relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 text-neutral-50 shadow-[0_18px_50px_-28px_rgba(0,0,0,0.9)] transition-[padding] duration-300 ease-out',
                'before:pointer-events-none before:absolute before:inset-x-12 before:-top-20 before:h-28 before:rounded-full before:bg-[var(--activity-accent)] before:opacity-10 before:blur-3xl',
                prominent ? 'px-8 py-16' : 'p-6',
                stopping
                    ? 'animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards'
                    : 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-6',
            )}
            style={{
                '--activity-accent': accent,
                animationDuration: stopping ? `${STOP_ANIM_MS}ms` : '520ms',
                animationTimingFunction: stopping ? EASE_OUT : EASE_THUNK,
            } as CSSProperties}
        >
            {prominent ? (
                <div className="relative flex flex-col items-center gap-6 text-center">
                    {activity.project && (
                        <ProjectTag
                            project={activity.project}
                            className="max-w-48 rounded-full bg-white/6 px-2.5 py-1 text-neutral-300 ring-1 ring-white/10"
                        />
                    )}
                    <p className="max-w-md truncate text-xl font-semibold leading-snug tracking-[-0.01em]">
                        {activity.description || 'No description'}
                    </p>
                    <div
                        className="font-mono text-6xl font-semibold leading-none tabular-nums tracking-[-0.06em]"
                        aria-live="polite"
                    >
                        {formatDuration(ms)}
                    </div>
                    <span className="text-xs text-neutral-400">
                        since {formatClock(since)}
                    </span>
                    <Button
                        onClick={handleStop}
                        variant="destructive"
                        size="sm"
                        disabled={stopping}
                        className="mt-2 bg-red-500 text-white shadow-[0_10px_24px_-14px_rgba(239,68,68,0.9)] transition-transform hover:bg-red-600 active:scale-95"
                    >
                        <Square data-icon="inline-start" /> Stop
                    </Button>
                </div>
            ) : (
                <div className="relative">
                    <div className="flex items-baseline justify-between gap-4">
                        <p className="min-w-0 flex-1 truncate text-xl font-semibold leading-snug tracking-[-0.01em]">
                            {activity.description || 'No description'}
                        </p>
                        <div
                            className="font-mono text-3xl font-semibold leading-none tabular-nums tracking-[-0.06em]"
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
                                    className="max-w-40 rounded-full bg-white/6 px-2.5 py-1 text-neutral-300 ring-1 ring-white/10"
                                />
                            )}
                            <span className="text-xs text-neutral-400">
                                since {formatClock(since)}
                            </span>
                        </div>
                        <Button
                            onClick={handleStop}
                            variant="destructive"
                            size="sm"
                            disabled={stopping}
                            className="bg-red-500 text-white shadow-[0_10px_24px_-14px_rgba(239,68,68,0.9)] transition-transform hover:bg-red-600 active:scale-95"
                        >
                            <Square data-icon="inline-start" /> Stop
                        </Button>
                    </div>
                </div>
            )}
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10" />
            <div
                className={cn(
                    'absolute bottom-0 left-0 h-0.5 bg-[var(--activity-accent)] transition-[width] ease-linear',
                    stopping ? 'duration-300' : 'duration-1000',
                )}
                style={{
                    width: stopping ? '100%' : `${minutePct}%`,
                    backgroundColor: accent,
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
