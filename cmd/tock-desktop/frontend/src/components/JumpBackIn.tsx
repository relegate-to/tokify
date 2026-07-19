import { Play } from 'lucide-react';

import type { Activity } from '@/types';
import { projectColor } from '@/lib/colors';
import { formatTotal } from '@/lib/time';
import { cn } from '@/lib/utils';

export function JumpBackIn({
    items,
    contextLabel,
    onResume,
}: {
    items: Activity[];
    contextLabel: string;
    onResume: (orig: Activity) => void;
}) {
    return (
        <section aria-label="Jump back in">
            <div className="mb-3.5 flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-foreground">
                    Jump back in
                </h3>
                {contextLabel && (
                    <span className="text-xs text-navigation-muted-foreground">
                        {contextLabel}
                    </span>
                )}
            </div>
            <div className="grid grid-cols-2 gap-3">
                {items.map((a) => (
                    <QuickStartTile
                        key={String(a.start_time)}
                        activity={a}
                        onResume={onResume}
                    />
                ))}
            </div>
        </section>
    );
}

function QuickStartTile({
    activity,
    onResume,
}: {
    activity: Activity;
    onResume: (orig: Activity) => void;
}) {
    const startMs = new Date(activity.start_time as any).getTime();
    const endMs = activity.end_time
        ? new Date(activity.end_time as any).getTime()
        : startMs;
    const durMs = Math.max(0, endMs - startMs);
    const title = activity.description || 'No description';
    const project = activity.project || '';
    const resumeLabel = project
        ? `Resume ${title} in ${project}`
        : `Resume ${title}`;

    return (
        <button
            type="button"
            onClick={() => onResume(activity)}
            aria-label={resumeLabel}
            className={cn(
                'group flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5 text-left',
                'transition-[transform,box-shadow,border-color] duration-150 ease-out',
                'hover:-translate-y-0.5 hover:border-ring/40 hover:shadow-[0_12px_26px_-14px_rgba(17,19,24,0.3)]',
                'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30',
                'active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
            )}
        >
            <span className="truncate text-sm font-medium text-foreground">
                {title}
            </span>
            <div className="flex items-center justify-between gap-2.5">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: projectColor(project) }}
                    />
                    <span className="truncate text-[12.5px] text-muted-foreground">
                        {project || 'No project'}
                    </span>
                </span>
                <span className="relative h-4 min-w-[52px] shrink-0">
                    <span className="absolute inset-0 flex items-center justify-end font-mono text-xs tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0">
                        {formatTotal(durMs)}
                    </span>
                    <span className="absolute inset-0 flex items-center justify-end gap-1.5 text-[12.5px] font-medium text-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <Play className="size-2.5 fill-current" strokeWidth={0} />
                        Start
                    </span>
                </span>
            </div>
        </button>
    );
}
