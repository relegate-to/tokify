// Ported from the desktop (cmd/tock-desktop/frontend/src/lib/time.ts).
const pad = (n: number) => String(n).padStart(2, '0');

export function formatClock(d: Date) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatStopwatch(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}

// Parses an RFC 3339 instant for display. Desktop timestamps carry nanoseconds,
// which not every JS engine's Date accepts, so the fraction is cut to
// milliseconds here; the original string is what gets written back.
export function parseInstant(s: string): Date {
    return new Date(s.replace(/(\.\d{3})\d+/, '$1'));
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function dayLabel(d: Date) {
    const today = startOfDay(new Date()).getTime();
    const diffDays = Math.round((today - startOfDay(d).getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
}

export function formatTotal(ms: number) {
    const total = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

// Reads the sync format's "2006-01-02 15:04" as local time.
export function parseSyncTime(s: string): Date {
    const [date, time] = s.split(' ');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi);
}
