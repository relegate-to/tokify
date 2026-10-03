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
