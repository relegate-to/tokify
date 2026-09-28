import { useState, type CSSProperties } from 'react';
import { Pencil } from 'lucide-react';

import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { EASE_OUT, EASE_THUNK } from '@/lib/motion';
import { formatClock, formatStopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { EditActivityDialog } from '@/components/EditActivityDialog';

const STOP_ANIM_MS = 380;

export function NowRunning({
    activity,
    projects,
    onStop,
    onUpdate,
}: {
    activity: Activity;
    projects: string[];
    onStop: () => void;
    onUpdate: (
        orig: Activity,
        description: string,
        project: string,
        notes: string,
        startISO: string,
        endISO: string,
    ) => void;
}) {
    const since = new Date(activity.start_time as any);
    const now = useNow();
    const ms = now - since.getTime();
    const [stopping, setStopping] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const project = activity.project || '';

    const handleStop = () => {
        if (stopping) return;
        setStopping(true);
        window.setTimeout(onStop, STOP_ANIM_MS);
    };

    return (
        <>
        <section
            aria-label="Currently running"
            className={cn(
                'flex min-h-[140px] flex-wrap items-center gap-x-[34px] gap-y-5 rounded-[16px] bg-running-card px-[34px] py-[30px] text-running-card-foreground compact:min-h-0 compact:flex-col compact:flex-nowrap compact:items-stretch compact:gap-y-3.5 compact:px-[18px] compact:py-4',
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
            <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-[7px] compact:basis-auto">
                <div className="flex items-center gap-[9px]">
                    <span
                        aria-hidden
                        className="size-1.5 shrink-0 animate-live-pulse rounded-full bg-live-dot-hero motion-reduce:animate-none"
                    />
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-running-card-faint">
                        Running since {formatClock(since)}
                    </span>
                </div>
                <p className="truncate text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] compact:text-[20px]">
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

            <div className="flex shrink-0 items-center gap-[22px] compact:gap-1.5 compact:border-t compact:border-running-card-faint/20 compact:pt-3.5">
                <div
                    className="font-mono text-[28px] font-medium leading-none tabular-nums tracking-[-0.02em] compact:mr-auto compact:text-[22px]"
                    aria-live="polite"
                >
                    {formatStopwatch(ms)}
                </div>
                <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-running-card-muted compact:size-8 transition-colors hover:bg-running-card-control-hover hover:text-running-card-foreground"
                    title="Edit activity and notes"
                    aria-label="Edit running activity and notes"
                >
                    <Pencil className="size-4" />
                </button>
                <button
                    type="button"
                    onClick={handleStop}
                    disabled={stopping}
                    className="flex shrink-0 items-center gap-[9px] rounded-[10px] bg-running-stop px-5 py-3 text-sm compact:px-4 compact:py-2 font-semibold text-running-stop-foreground transition-[background-color,transform] hover:bg-running-stop-hover active:scale-95 disabled:opacity-70"
                >
                    <span
                        aria-hidden
                        className="size-[9px] rounded-[2px] bg-running-stop-glyph"
                    />
                    Stop
                </button>
            </div>
        </section>
        <EditActivityDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            activity={activity}
            projects={projects}
            onUpdate={onUpdate}
        />
        </>
    );
}
