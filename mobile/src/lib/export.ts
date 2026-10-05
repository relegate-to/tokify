// The desktop's export (internal/app/export/output.go, and the range clipping
// in internal/services/activity), so a file exported from the phone reads the
// same as one from the desktop.
import { goString } from '@/crypto/gojson';
import { parseSyncTime } from '@/lib/time';

export type ExportFormat = 'txt' | 'csv' | 'json';
export type ExportEntry = { description: string; project: string; start: string; end: string };
type Activity = { description: string; project: string; start: Date; end: Date };

const pad = (n: number, w = 2) => String(Math.trunc(n)).padStart(w, '0');

// Go's time.RFC3339 in local time: 2026-10-05T09:00:00+09:00, or Z at UTC.
function rfc3339(d: Date) {
    const off = -d.getTimezoneOffset();
    const zone = off === 0 ? 'Z' : `${off > 0 ? '+' : '-'}${pad(Math.abs(off) / 60)}:${pad(Math.abs(off) % 60)}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hm = (ms: number) => `${Math.trunc(ms / 3_600_000)}h ${Math.trunc(ms / 60_000) % 60}m`;

// Activities in [from, to], clipped to the range as the desktop's report does;
// from and to are local days (YYYY-MM-DD), to inclusive.
export function selectForExport(entries: ExportEntry[], opts: { from?: string; to?: string; project?: string }): Activity[] {
    const lower = opts.from ? new Date(`${opts.from}T00:00:00`) : null;
    const upper = opts.to ? new Date(new Date(`${opts.to}T00:00:00`).setDate(new Date(`${opts.to}T00:00:00`).getDate() + 1)) : null;
    const out: Activity[] = [];
    for (const e of entries) {
        if (opts.project && e.project !== opts.project) continue;
        let start = parseSyncTime(e.start);
        let end = parseSyncTime(e.end);
        if (lower && start < lower) start = lower;
        if (upper && end > upper) end = upper;
        if (end > start) out.push({ description: e.description, project: e.project, start, end });
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function renderExport(format: ExportFormat, acts: Activity[]): string {
    if (format === 'csv') return renderCSV(acts);
    if (format === 'json') return renderJSON(acts);
    return renderText(acts);
}

function renderText(acts: Activity[]) {
    if (acts.length === 0) return 'No activities found for the specified period.\n';
    const ids = new Map<Activity, string>();
    const perDay = new Map<string, number>();
    for (const a of acts) {
        const day = dayOf(a.start);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
        ids.set(a, `${day}-${pad(perDay.get(day)!)}`);
    }
    const byProject = new Map<string, Activity[]>();
    for (const a of acts) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a]);
    // Go sorts project names bytewise.
    const names = [...byProject.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    let out = '\n📊 Time Tracking Report\n========================\n\n';
    let total = 0;
    for (const name of names) {
        const list = byProject.get(name)!;
        const ms = list.reduce((sum, a) => sum + (a.end.getTime() - a.start.getTime()), 0);
        total += ms;
        out += `📁 ${name}: ${hm(ms)}\n`;
        for (const a of list) {
            out += `   [${ids.get(a)}] ${clock(a.start)} - ${clock(a.end)} (${hm(a.end.getTime() - a.start.getTime())}) | ${a.description}\n`;
        }
        out += '\n';
    }
    return out + `⏱️  Total: ${hm(total)}\n`;
}

// Go's encoding/csv: quoted only when needed, quotes doubled, \n line ends.
function csvField(f: string) {
    const needs = f !== '' && (f === '\\.' || /[",\r\n]/.test(f) || /^\s/u.test(f));
    return needs ? `"${f.replace(/"/g, '""')}"` : f;
}

function renderCSV(acts: Activity[]) {
    const rows = [['project', 'description', 'start_time', 'end_time', 'duration_minutes']];
    for (const a of acts) {
        const minutes = Math.floor(((a.end.getTime() - a.start.getTime()) / 60_000) * 100) / 100;
        rows.push([a.project, a.description, rfc3339(a.start), rfc3339(a.end), minutes.toFixed(2)]);
    }
    return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

// json.MarshalIndent of models.Activity: its fields, then "duration" as HH:MM:SS.
function renderJSON(acts: Activity[]) {
    if (acts.length === 0) return '[]\n';
    const items = acts.map((a) => {
        const s = Math.round((a.end.getTime() - a.start.getTime()) / 1000);
        const duration = `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
        const fields: [string, string][] = [
            ['description', a.description],
            ['project', a.project],
            ['start_time', rfc3339(a.start)],
            ['end_time', rfc3339(a.end)],
            ['duration', duration],
        ];
        return '  {\n' + fields.map(([k, v]) => `    ${goString(k)}: ${goString(v)}`).join(',\n') + '\n  }';
    });
    return '[\n' + items.join(',\n') + '\n]\n';
}
