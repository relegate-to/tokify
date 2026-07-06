import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { startOfDay } from '@/lib/time';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_START_H = 8;
const WINDOW_END_H = 18;

// Plots a day's activities at their actual time of day on a hairline track,
// colored by project. The window covers at least 08:00–18:00 and stretches to
// whole hours to fit earlier or later work; a running activity extends to now.
// Purely decorative — the numbers next to it carry the same information.
export function DayTimeline({
    day,
    activities,
    className,
}: {
    day: Date;
    activities: Activity[];
    className?: string;
}) {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = dayStart + DAY_MS;

    const spans = activities.map((a) => {
        const start = new Date(a.start_time as any).getTime();
        const end = a.end_time
            ? new Date(a.end_time as any).getTime()
            : Date.now();
        return {
            start: Math.min(Math.max(start, dayStart), dayEnd),
            end: Math.min(Math.max(end, start), dayEnd),
            project: a.project ?? '',
            running: !a.end_time,
        };
    });

    let winStart = dayStart + WINDOW_START_H * HOUR_MS;
    let winEnd = dayStart + WINDOW_END_H * HOUR_MS;
    for (const s of spans) {
        winStart = Math.min(
            winStart,
            dayStart + Math.floor((s.start - dayStart) / HOUR_MS) * HOUR_MS,
        );
        winEnd = Math.max(
            winEnd,
            dayStart + Math.ceil((s.end - dayStart) / HOUR_MS) * HOUR_MS,
        );
    }
    winStart = Math.max(winStart, dayStart);
    winEnd = Math.min(winEnd, dayEnd);
    const window = winEnd - winStart;

    return (
        <div
            aria-hidden
            className={cn(
                'relative h-1 min-w-8 overflow-hidden rounded-full bg-border/60',
                className,
            )}
        >
            {spans.map((s, i) => (
                <span
                    key={i}
                    className={cn(
                        'absolute inset-y-0 rounded-full',
                        s.running && 'animate-pulse motion-reduce:animate-none',
                    )}
                    style={{
                        left: `${((s.start - winStart) / window) * 100}%`,
                        width: `max(${((s.end - s.start) / window) * 100}%, 3px)`,
                        backgroundColor: s.project
                            ? projectColor(s.project)
                            : 'var(--muted-foreground)',
                    }}
                />
            ))}
        </div>
    );
}
