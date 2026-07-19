import type { Activity } from '@/types';

export function startOfDay(d: Date) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function groupByLocalDate<T extends Activity>(
    activities: T[],
    includeToday: boolean,
): { dateKey: string; date: Date; items: T[] }[] {
    const todayStart = startOfDay(new Date()).getTime();
    const buckets = new Map<string, { date: Date; items: T[] }>();

    for (const a of activities) {
        const start = new Date(a.start_time as any);
        const dayStart = startOfDay(start);
        if (!includeToday && dayStart.getTime() >= todayStart) continue;
        const key = `${dayStart.getFullYear()}-${dayStart.getMonth()}-${dayStart.getDate()}`;
        const existing = buckets.get(key);
        if (existing) {
            existing.items.unshift(a);
        } else {
            buckets.set(key, { date: dayStart, items: [a] });
        }
    }

    return Array.from(buckets.entries())
        .map(([dateKey, value]) => ({
            dateKey,
            ...value,
            items: [...value.items].sort(
                (a, b) =>
                    new Date(b.start_time as any).getTime() -
                    new Date(a.start_time as any).getTime(),
            ),
        }))
        .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export function dayLabel(d: Date) {
    const today = startOfDay(new Date()).getTime();
    const diffDays = Math.round((today - d.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) {
        return d.toLocaleDateString(undefined, { weekday: 'long' });
    }
    return d.toLocaleDateString(undefined, {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
    });
}

export function totalDuration(activities: Activity[]) {
    let ms = 0;
    for (const a of activities) {
        const end = a.end_time
            ? new Date(a.end_time as any).getTime()
            : Date.now();
        ms += end - new Date(a.start_time as any).getTime();
    }
    return ms;
}

export function pad(n: number) {
    return n < 10 ? `0${n}` : String(n);
}
export function formatClock(d: Date) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Parses "HH:MM" and combines it with the date portion of `base` to produce
// an RFC3339 ISO string in the local timezone. Returns null on invalid input.
export function buildClockISO(base: Date, hhmm: string): string | null {
    const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(hhmm);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    const next = new Date(base);
    next.setHours(h, min, 0, 0);
    // Local ISO with offset, e.g. 2026-06-18T09:42:00+01:00 — Go time.Parse
    // RFC3339 accepts this.
    const tz = -next.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    const tzAbs = Math.abs(tz);
    const off = `${sign}${pad(Math.floor(tzAbs / 60))}:${pad(tzAbs % 60)}`;
    return (
        `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` +
        `T${pad(next.getHours())}:${pad(next.getMinutes())}:${pad(next.getSeconds())}` +
        off
    );
}
export function formatDuration(ms: number) {
    const total = Math.max(0, Math.floor(ms / 60_000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${pad(h)}:${pad(m)}`;
}
export function formatTotal(ms: number) {
    const total = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}
