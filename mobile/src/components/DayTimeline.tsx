import { View } from 'react-native';

import { projectColorClass } from '@/lib/colors';
import { cn } from '@/lib/utils';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_START_H = 8;
const WINDOW_END_H = 18;

export type DaySpan = { key: string; start: number; end: number; project: string };

// The desktop's DayTimeline: a day's activities at their time of day on a
// hairline track, coloured by project. The window covers at least 08:00–18:00
// and widens to whole hours for earlier or later work. Decorative: the total
// beside it carries the same information.
export function DayTimeline({ day, spans, className }: { day: Date; spans: DaySpan[]; className?: string }) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const dayEnd = dayStart + DAY_MS;
    const clipped = spans.map((s) => ({ ...s, start: Math.min(Math.max(s.start, dayStart), dayEnd), end: Math.min(Math.max(s.end, s.start), dayEnd) }));
    let winStart = dayStart + WINDOW_START_H * HOUR_MS;
    let winEnd = dayStart + WINDOW_END_H * HOUR_MS;
    for (const s of clipped) {
        winStart = Math.min(winStart, dayStart + Math.floor((s.start - dayStart) / HOUR_MS) * HOUR_MS);
        winEnd = Math.max(winEnd, dayStart + Math.ceil((s.end - dayStart) / HOUR_MS) * HOUR_MS);
    }
    winStart = Math.max(winStart, dayStart);
    const window = Math.min(winEnd, dayEnd) - winStart;
    return (
        <View importantForAccessibility="no-hide-descendants" className={cn('h-1 min-w-8 overflow-hidden rounded-full bg-border/60', className)}>
            {clipped.map((s) => (
                <View
                    key={s.key}
                    className={cn('absolute bottom-0 top-0 rounded-full', s.project ? projectColorClass(s.project) : 'bg-muted-foreground')}
                    style={{ left: `${((s.start - winStart) / window) * 100}%`, width: `${((s.end - s.start) / window) * 100}%`, minWidth: 3 }}
                />
            ))}
        </View>
    );
}
