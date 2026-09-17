import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { startOfDay } from '@/lib/time';
import { useNow } from '@/lib/use-now';

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
    removingKeys,
    className,
}: {
    day: Date;
    activities: Activity[];
    removingKeys?: Set<string>;
    className?: string;
}) {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = dayStart + DAY_MS;
    const now = useNow(activities.some((activity) => !activity.end_time));

    const spans = activities.map((a) => {
        const start = new Date(a.start_time as any).getTime();
        const end = a.end_time
            ? new Date(a.end_time as any).getTime()
            : now;
        return {
            key: String(a.start_time),
            start: Math.min(Math.max(start, dayStart), dayEnd),
            end: Math.min(Math.max(end, start), dayEnd),
            project: a.project ?? '',
            running: !a.end_time,
            removing: !!removingKeys?.has(String(a.start_time)),
        };
    });

    // The window is sized to the spans that are staying, so it starts easing to
    // its new shape while the departing span is still fading out. Sizing it to
    // everything instead would hold the old window and then snap when the span
    // finally unmounted.
    const staying = spans.filter((s) => !s.removing);
    let winStart = dayStart + WINDOW_START_H * HOUR_MS;
    let winEnd = dayStart + WINDOW_END_H * HOUR_MS;
    for (const s of staying.length > 0 ? staying : spans) {
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
            {spans.map((s) => (
                // Keyed by start time, not index: an index key hands a removed
                // span's DOM node to its neighbour, so every segment after it
                // teleports to a new position instead of easing there.
                <span
                    key={s.key}
                    className={cn(
                        'absolute inset-y-0 rounded-full',
                        'transition-[left,width,opacity] duration-200 ease-out motion-reduce:transition-none',
                        s.running && 'animate-pulse motion-reduce:animate-none',
                    )}
                    style={{
                        left: `${((s.start - winStart) / window) * 100}%`,
                        width: `max(${((s.end - s.start) / window) * 100}%, 3px)`,
                        opacity: s.removing ? 0 : 1,
                        backgroundColor: s.project
                            ? projectColor(s.project)
                            : 'var(--muted-foreground)',
                    }}
                />
            ))}
        </div>
    );
}
