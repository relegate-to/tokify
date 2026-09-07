import { useState, type CSSProperties } from 'react';

import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { EASE_OUT, EASE_THUNK } from '@/lib/motion';
import { formatClock, formatStopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';

const STOP_ANIM_MS = 380;

export function NowRunning({
    activity,
    onStop,
}: {
    activity: Activity;
    onStop: () => void;
}) {
    const since = new Date(activity.start_time as any);
    const now = useNow();
    const ms = now - since.getTime();
    const [stopping, setStopping] = useState(false);
    const project = activity.project || '';

    const handleStop = () => {
        if (stopping) return;
        setStopping(true);
        window.setTimeout(onStop, STOP_ANIM_MS);
    };

    return (
        <section
            aria-label="Currently running"
            className={cn(
                'flex min-h-[140px] items-center gap-[34px] rounded-[16px] bg-running-card px-[34px] py-[30px] text-running-card-foreground',
                stopping
                    ? 'animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards'
                    : 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-6',
            )}
            style={
                {
                    animationDuration: stopping ? `${STOP_ANIM_MS}ms` : '520ms',
                    animationTimingFunction: stopping ? EASE_OUT : EASE_THUNK,
                } as CSSProperties
            }
        >
            <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
                <div className="flex items-center gap-[9px]">
                    <span
                        aria-hidden
                        className="size-1.5 shrink-0 animate-live-pulse rounded-full bg-live-dot-hero motion-reduce:animate-none"
                    />
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-running-card-faint">
                        Running since {formatClock(since)}
                    </span>
                </div>
                <p className="truncate text-[30px] font-semibold leading-[1.15] tracking-[-0.02em]">
                    {activity.description || 'No description'}
                </p>
                <div className="flex h-6 min-w-0 items-center gap-2">
                    <span
                        aria-hidden
                        className="size-[7px] shrink-0 rounded-[2px]"
                        style={{ backgroundColor: projectColor(project) }}
                    />
                    <span className="truncate text-sm font-medium text-running-card-muted">
                        {project || 'No project'}
                    </span>
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-[22px]">
                <div
                    className="font-mono text-[28px] font-medium leading-none tabular-nums tracking-[-0.02em]"
                    aria-live="polite"
                >
                    {formatStopwatch(ms)}
                </div>
                <button
                    type="button"
                    onClick={handleStop}
                    disabled={stopping}
                    className="flex shrink-0 items-center gap-[9px] rounded-[10px] bg-running-stop px-5 py-3 text-sm font-semibold text-running-stop-foreground transition-[background-color,transform] hover:bg-running-stop-hover active:scale-95 disabled:opacity-70"
                >
                    <span
                        aria-hidden
                        className="size-[9px] rounded-[2px] bg-running-stop-glyph"
                    />
                    Stop
                </button>
            </div>
        </section>
    );
}
