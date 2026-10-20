import { memo } from 'react';

import type { Activity, ActivityItem } from '@/types';
import { cn } from '@/lib/utils';
import { REMOVE_ANIM_MS, EASE_OUT } from '@/lib/motion';
import { dayLabel, formatTotal } from '@/lib/time';
import { ActivityRow } from '@/components/ActivityRow';
import { DayTimeline } from '@/components/DayTimeline';

// Shared day-header rhythm: label on the left, the day map filling the
// middle, total on the right. Used for every day in both views.
export function DayHeader({
    label,
    day,
    activities,
    removingKeys,
    totalMs,
    variant = 'now',
}: {
    label: string;
    day: Date;
    activities: Activity[];
    removingKeys?: Set<string>;
    totalMs: number;
    variant?: 'now' | 'history';
}) {
    const isHistory = variant === 'history';
    return (
        <div
            className={cn(
                'flex items-center gap-3.5 px-3',
                isHistory ? 'mb-3' : 'mb-2.5',
            )}
        >
            <h3
                className={cn(
                    'w-[76px] shrink-0',
                    isHistory
                        ? 'text-sm font-semibold text-foreground'
                        : 'text-[11.5px] font-bold uppercase tracking-[0.04em] text-navigation-muted-foreground',
                )}
            >
                {label}
            </h3>
            <DayTimeline
                day={day}
                activities={activities}
                removingKeys={removingKeys}
                className="flex-1"
            />
            <span
                className={cn(
                    'w-14 shrink-0 text-right font-mono tabular-nums',
                    isHistory
                        ? 'text-[13px] text-muted-foreground'
                        : 'text-[12.5px] font-semibold text-day-total-foreground',
                )}
            >
                {formatTotal(totalMs)}
            </span>
        </div>
    );
}

// A stable per-row key: a local row is unique by start time, but a shared row can
// collide with a local one (or another author's) on start time, so fold the
// author in for shared rows.
const rowKey = (a: ActivityItem) =>
    a.shared ? `s:${a.shared.authorId}:${String(a.start_time)}` : String(a.start_time);

type DayGroupProps = {
    day: Date;
    activities: ActivityItem[];
    removingKeys: Set<string>;
    variant?: 'now' | 'history';
    onUpdate: (orig: Activity, description: string, project: string, notes: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume?: (orig: Activity) => void;
};

// Regrouping the log hands every day a fresh array even when its rows are the
// same objects, and a delete swaps in a new removingKeys set, so compare what
// this day actually shows: an edit or a delete re-renders its own day only.
function sameDay(a: DayGroupProps, b: DayGroupProps): boolean {
    return (
        a.day.getTime() === b.day.getTime() &&
        a.activities.length === b.activities.length &&
        a.activities.every((x, i) => {
            const key = String(x.start_time);
            return (
                x === b.activities[i] &&
                a.removingKeys.has(key) === b.removingKeys.has(key)
            );
        }) &&
        a.variant === b.variant &&
        a.onUpdate === b.onUpdate &&
        a.onRemove === b.onRemove &&
        a.onResume === b.onResume
    );
}

export const DayGroup = memo(function DayGroup({
    day,
    activities,
    removingKeys,
    variant = 'now',
    onUpdate,
    onRemove,
    onResume,
}: DayGroupProps) {
    const visible = activities.filter(
        (a) => a.shared || !removingKeys.has(String(a.start_time)),
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
        // A day losing its last row fades out where it stands, keeping its
        // height; the space it held is closed afterwards by the FLIP pass, not
        // by animating this box shorter.
        <div
            data-flip-group={String(day.getTime())}
            style={{
                opacity: allRemoving ? 0 : 1,
                transition: `opacity ${REMOVE_ANIM_MS}ms ${EASE_OUT}`,
                // The Log keeps a year of days mounted. Days off screen skip
                // style, layout and paint until scrolled near — a theme switch
                // went from ~140ms to ~25ms. The size stands in until a day is
                // first drawn (header plus a row height each), then `auto`
                // keeps its real one, so the scrollbar barely moves.
                ...(variant === 'history' && {
                    contentVisibility: 'auto',
                    containIntrinsicSize: `auto ${32 + 44 * activities.length}px`,
                }),
            }}
        >
            <div
                className={cn(
                    !allRemoving &&
                        'animate-in fade-in-0 slide-in-from-top-1 duration-300',
                )}
            >
                <DayHeader
                    label={dayLabel(day)}
                    day={day}
                    activities={activities}
                    removingKeys={removingKeys}
                    totalMs={totalMs}
                    variant={variant}
                />
                <ul className="flex flex-col">
                    {activities.map((a) => (
                        <ActivityRow
                            key={rowKey(a)}
                            activity={a}
                            isRemoving={
                                !a.shared &&
                                removingKeys.has(String(a.start_time))
                            }
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                            onResume={onResume}
                        />
                    ))}
                </ul>
            </div>
        </div>
    );
}, sameDay);
