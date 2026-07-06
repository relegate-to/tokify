import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { REMOVE_ANIM_MS } from '@/lib/motion';
import { dayLabel, formatTotal } from '@/lib/time';
import { ActivityRow } from '@/components/ActivityRow';
import { DayTimeline } from '@/components/DayTimeline';

// Shared day-header rhythm: label on the left, the day map filling the
// middle, total on the right. Used for every day in both views.
export function DayHeader({
    label,
    day,
    activities,
    totalMs,
}: {
    label: string;
    day: Date;
    activities: Activity[];
    totalMs: number;
}) {
    return (
        <div className="mb-1.5 flex items-center gap-3 px-3">
            <h3 className="shrink-0 text-xs font-medium text-muted-foreground">
                {label}
            </h3>
            <DayTimeline day={day} activities={activities} className="flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatTotal(totalMs)}
            </span>
        </div>
    );
}

export function DayGroup({
    day,
    activities,
    projects,
    removingKeys,
    onUpdate,
    onRemove,
    onResume,
}: {
    day: Date;
    activities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume?: (orig: Activity) => void;
}) {
    const visible = activities.filter(
        (a) => !removingKeys.has(String(a.start_time)),
    );
    const totalMs = visible.reduce((sum, a) => {
        const startMs = new Date(a.start_time as any).getTime();
        const endMs = a.end_time
            ? new Date(a.end_time as any).getTime()
            : startMs;
        return sum + (endMs - startMs);
    }, 0);
    const allRemoving = activities.length > 0 && visible.length === 0;
    return (
        <div
            className="grid transition-[grid-template-rows,opacity] ease-out"
            style={{
                gridTemplateRows: allRemoving ? '0fr' : '1fr',
                opacity: allRemoving ? 0 : 1,
                transitionDuration: `${REMOVE_ANIM_MS}ms`,
            }}
        >
            <div
                className={cn(
                    'min-h-0 overflow-hidden',
                    !allRemoving &&
                        'animate-in fade-in-0 slide-in-from-top-1 duration-300',
                )}
            >
                <DayHeader
                    label={dayLabel(day)}
                    day={day}
                    activities={visible}
                    totalMs={totalMs}
                />
                <ul className="flex flex-col">
                    {activities.map((a) => (
                        <ActivityRow
                            key={String(a.start_time)}
                            activity={a}
                            projects={projects}
                            isRemoving={removingKeys.has(String(a.start_time))}
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                            onResume={onResume}
                        />
                    ))}
                </ul>
            </div>
        </div>
    );
}
