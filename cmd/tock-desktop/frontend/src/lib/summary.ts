import {
    addMonths,
    addWeeks,
    differenceInCalendarDays,
    differenceInCalendarWeeks,
    eachDayOfInterval,
    endOfMonth,
    endOfWeek,
    format,
    getDay,
    startOfDay,
    startOfMonth,
    startOfWeek,
    subDays,
} from 'date-fns';

import type { Activity } from '@/types';
import { projectColor } from '@/lib/colors';
import { activityTitle } from '@/lib/activity-label';

// Monday-anchored weeks throughout, matching how most people read a work week.
const WEEK_OPTS = { weekStartsOn: 1 as const };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function durationMs(a: Activity): number {
    if (!a.end_time) return 0;
    const start = new Date(a.start_time as any).getTime();
    const end = new Date(a.end_time as any).getTime();
    const ms = end - start;
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function dayKey(d: Date | string): string {
    return format(new Date(d as any), 'yyyy-MM-dd');
}

function parseDayKey(k: string): Date {
    return new Date(`${k}T00:00:00`);
}

function fmt(ms: number): string {
    const total = Math.max(0, Math.floor(ms / MINUTE));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

// A tight label for the donut center, where "356h 12m" would overflow the ring.
// Hours dominate the read; minutes only matter under an hour.
function compactDuration(ms: number): string {
    const h = ms / HOUR;
    if (h >= 10) return `${Math.round(h)}h`;
    if (h >= 1) return `${Math.round(h * 10) / 10}h`;
    return `${Math.max(0, Math.round(ms / MINUTE))}m`;
}

function hourLabel(h: number): string {
    const suffix = h < 12 ? 'a' : 'p';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}${suffix}`;
}

// ---- Daily project index ----------------------------------------------------
// Everything downstream reads from one pass: for each local day, how much time
// each project got. Project is the unit of color across every view, so keeping
// the per-project split from the start is what lets bars, ribbons, and streak
// squares all speak the same palette.

type DayAgg = Map<string, number>; // project -> ms

function dailyIndex(activities: Activity[]): Map<string, DayAgg> {
    const index = new Map<string, DayAgg>();
    for (const a of activities) {
        const ms = durationMs(a);
        if (ms <= 0) continue;
        const k = dayKey(a.start_time);
        let agg = index.get(k);
        if (!agg) {
            agg = new Map();
            index.set(k, agg);
        }
        const p = a.project ?? '';
        agg.set(p, (agg.get(p) ?? 0) + ms);
    }
    return index;
}

function aggTotal(agg: DayAgg): number {
    let t = 0;
    for (const v of agg.values()) t += v;
    return t;
}

function mergeInto(dst: DayAgg, src: DayAgg) {
    for (const [p, ms] of src) dst.set(p, (dst.get(p) ?? 0) + ms);
}

function dominant(agg: DayAgg): string {
    let best = '';
    let max = 0;
    for (const [p, ms] of agg) {
        if (ms > max) {
            max = ms;
            best = p;
        }
    }
    return best;
}

// A single project's slice of a bar.
export type Seg = { project: string; label: string; ms: number; color: string };

// A stacked bar: a labelled column composed of project segments.
export type StackBar = {
    label: string;
    total: number;
    segments: Seg[];
    labelMuted?: boolean;
    pinned?: boolean;
};

export type LegendItem = { name: string; color: string; ms: number };

function projectLabel(name: string): string {
    return name || 'No project';
}

function toSegments(agg: DayAgg, order: string[]): Seg[] {
    return order
        .filter((p) => (agg.get(p) ?? 0) > 0)
        .map((p) => ({
            project: p,
            label: projectLabel(p),
            ms: agg.get(p) ?? 0,
            color: projectColor(p),
        }));
}

// Stable stacking order (largest project at the base) so a color sits at the
// same height across every column in a chart.
function orderOf(aggs: DayAgg[]): string[] {
    const totals = new Map<string, number>();
    for (const agg of aggs) {
        for (const [p, ms] of agg) totals.set(p, (totals.get(p) ?? 0) + ms);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

function legendOf(aggs: DayAgg[], order: string[]): LegendItem[] {
    const totals = new Map<string, number>();
    for (const agg of aggs) {
        for (const [p, ms] of agg) totals.set(p, (totals.get(p) ?? 0) + ms);
    }
    return order.map((p) => ({
        name: projectLabel(p),
        color: projectColor(p),
        ms: totals.get(p) ?? 0,
    }));
}

// ---- Reports ----------------------------------------------------------------

export type ReportProject = {
    name: string;
    ms: number;
    color: string;
    pct: number;
    barPct: number;
};

export type ReportData = {
    periodLabel: string;
    eyebrow: string;
    totalMs: number;
    deltaMs: number;
    deltaPct: number;
    up: boolean;
    hasPrev: boolean;
    avgMs: number;
    avgSub: string;
    trackedLabel: string;
    bars: StackBar[];
    mix: Seg[];
    projects: ReportProject[];
    projectTotalMs: number;
    tasks: TaskRow[];
};

export type TaskRow = {
    title: string;
    project: string;
    color: string;
    ms: number;
    sessions: number;
};

// Top activities of the period, grouped by their title. A task's dot takes the
// color of the project it spent the most time under.
function topTasks(
    activities: Activity[],
    start: Date,
    end: Date,
    limit = 5,
): TaskRow[] {
    type Acc = {
        title: string;
        ms: number;
        sessions: number;
        projects: Map<string, number>;
    };
    const map = new Map<string, Acc>();
    for (const a of activities) {
        const s = new Date(a.start_time as any);
        if (s < start || s > end) continue;
        const ms = durationMs(a);
        if (ms <= 0) continue;
        const title = activityTitle(a.description, a.project);
        const key = title.toLowerCase();
        let acc = map.get(key);
        if (!acc) {
            acc = { title, ms: 0, sessions: 0, projects: new Map() };
            map.set(key, acc);
        }
        acc.ms += ms;
        acc.sessions += 1;
        const p = a.project ?? '';
        acc.projects.set(p, (acc.projects.get(p) ?? 0) + ms);
    }
    return [...map.values()]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, limit)
        .map((acc) => {
            const proj =
                [...acc.projects.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ??
                '';
            return {
                title: acc.title,
                project: projectLabel(proj),
                color: projectColor(proj),
                ms: acc.ms,
                sessions: acc.sessions,
            };
        });
}

type RangeSum = { total: number; byProject: DayAgg };

function sumRange(
    index: Map<string, DayAgg>,
    start: Date,
    end: Date,
): RangeSum {
    let total = 0;
    const byProject: DayAgg = new Map();
    for (const [k, agg] of index) {
        const d = parseDayKey(k);
        if (d < start || d > end) continue;
        total += aggTotal(agg);
        mergeInto(byProject, agg);
    }
    return { total, byProject };
}

function projectList(byProject: DayAgg, order: string[]): ReportProject[] {
    const total = aggTotal(byProject);
    const max = order.length ? byProject.get(order[0]) ?? 0 : 0;
    return order.map((p) => {
        const ms = byProject.get(p) ?? 0;
        return {
            name: projectLabel(p),
            ms,
            color: projectColor(p),
            pct: total ? Math.round((ms / total) * 100) : 0,
            barPct: max ? (ms / max) * 100 : 0,
        };
    });
}

function delta(total: number, prevTotal: number) {
    const d = total - prevTotal;
    return {
        deltaMs: d,
        deltaPct: prevTotal > 0 ? Math.round((d / prevTotal) * 100) : 0,
        up: d >= 0,
        hasPrev: prevTotal > 0,
    };
}

export function buildReport(
    activities: Activity[],
    period: 'weekly' | 'monthly',
    offset: number,
    now = new Date(),
): ReportData {
    const index = dailyIndex(activities);
    return period === 'weekly'
        ? buildWeekly(activities, index, offset, now)
        : buildMonthly(activities, index, offset, now);
}

function finishReport(
    periodLabel: string,
    eyebrow: string,
    buckets: { label: string; agg: DayAgg }[],
    cur: RangeSum,
    prev: RangeSum,
    avgDivisor: number,
    avgSub: string,
    trackedLabel: string,
    activities: Activity[],
    start: Date,
    end: Date,
): ReportData {
    const order = orderOf(buckets.map((b) => b.agg));
    const bars: StackBar[] = buckets.map((b) => ({
        label: b.label,
        total: aggTotal(b.agg),
        segments: toSegments(b.agg, order),
    }));
    return {
        periodLabel,
        eyebrow,
        totalMs: cur.total,
        ...delta(cur.total, prev.total),
        avgMs: avgDivisor ? cur.total / avgDivisor : 0,
        avgSub,
        trackedLabel,
        bars,
        mix: toSegments(cur.byProject, order),
        projects: projectList(cur.byProject, order),
        projectTotalMs: cur.total,
        tasks: topTasks(activities, start, end),
    };
}

function buildWeekly(
    activities: Activity[],
    index: Map<string, DayAgg>,
    offset: number,
    now: Date,
): ReportData {
    const start = addWeeks(startOfWeek(now, WEEK_OPTS), offset);
    const end = endOfWeek(start, WEEK_OPTS);
    const days = eachDayOfInterval({ start, end });
    const buckets = days.map((d) => ({
        label: format(d, 'EEE'),
        agg: index.get(dayKey(d)) ?? new Map<string, number>(),
    }));
    const cur = sumRange(index, start, end);
    const prevStart = addWeeks(start, -1);
    const prev = sumRange(index, prevStart, endOfWeek(prevStart, WEEK_OPTS));
    const trackedCount = buckets.filter((b) => aggTotal(b.agg) > 0).length;
    return finishReport(
        `${format(start, 'MMM d')} – ${format(end, 'MMM d')}`,
        offset === 0 ? 'This week' : 'Week total',
        buckets,
        cur,
        prev,
        trackedCount,
        'avg / tracked day',
        `${trackedCount} / 7`,
        activities,
        start,
        end,
    );
}

function buildMonthly(
    activities: Activity[],
    index: Map<string, DayAgg>,
    offset: number,
    now: Date,
): ReportData {
    const monthBase = addMonths(startOfMonth(now), offset);
    const start = startOfMonth(monthBase);
    const end = endOfMonth(monthBase);
    const weekCount = differenceInCalendarWeeks(end, start, WEEK_OPTS) + 1;
    const buckets = Array.from({ length: weekCount }, (_, i) => ({
        label: `Wk ${i + 1}`,
        agg: new Map<string, number>(),
    }));
    let trackedDays = 0;
    for (const d of eachDayOfInterval({ start, end })) {
        const agg = index.get(dayKey(d));
        if (!agg) continue;
        trackedDays += 1;
        mergeInto(buckets[differenceInCalendarWeeks(d, start, WEEK_OPTS)].agg, agg);
    }
    const cur = sumRange(index, start, end);
    const prevBase = addMonths(start, -1);
    const prev = sumRange(
        index,
        startOfMonth(prevBase),
        endOfMonth(prevBase),
    );
    const trackedWeeks = buckets.filter((b) => aggTotal(b.agg) > 0).length;
    const daysInMonth = differenceInCalendarDays(end, start) + 1;
    return finishReport(
        format(monthBase, 'MMMM yyyy'),
        offset === 0 ? 'This month' : 'Month total',
        buckets,
        cur,
        prev,
        trackedWeeks,
        'avg / tracked week',
        `${trackedDays} / ${daysInMonth}`,
        activities,
        start,
        end,
    );
}

// ---- Charts -----------------------------------------------------------------

export type ChartRange = '7' | '30' | 'all';

export type DonutSeg = {
    name: string;
    ms: number;
    color: string;
    pct: number;
    arcPct: number;
};

export function buildDonut(
    activities: Activity[],
    range: ChartRange,
    now = new Date(),
): { segs: DonutSeg[]; totalMs: number; totalLabel: string; sub: string } {
    const index = dailyIndex(activities);
    const start =
        range === 'all'
            ? null
            : startOfDay(subDays(now, range === '7' ? 6 : 29));
    const byProject: DayAgg = new Map();
    let total = 0;
    for (const [k, agg] of index) {
        if (start && parseDayKey(k) < start) continue;
        total += aggTotal(agg);
        mergeInto(byProject, agg);
    }
    const segs: DonutSeg[] = [...byProject.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, ms]) => ({
            name: projectLabel(name),
            ms,
            color: projectColor(name),
            pct: total ? Math.round((ms / total) * 100) : 0,
            arcPct: total ? (ms / total) * 100 : 0,
        }));
    const sub =
        range === '7' ? 'this week' : range === '30' ? 'past 30 days' : 'past year';
    return { segs, totalMs: total, totalLabel: compactDuration(total), sub };
}

// Where the hours land in a day: each activity's duration split across the
// clock hours it spans, so a 09:40–11:15 session feeds 9, 10, and 11. Each bar
// takes the color of the project that dominates that hour.
export type HourData = { bars: StackBar[]; peakLabel: string };

export function buildHourly(activities: Activity[]): HourData {
    const perHour: DayAgg[] = Array.from({ length: 24 }, () => new Map());
    for (const a of activities) {
        if (!a.end_time) continue;
        const start = new Date(a.start_time as any).getTime();
        const end = new Date(a.end_time as any).getTime();
        if (!(end > start)) continue;
        const p = a.project ?? '';
        let t = start;
        while (t < end) {
            const cur = new Date(t);
            const next = new Date(
                cur.getFullYear(),
                cur.getMonth(),
                cur.getDate(),
                cur.getHours() + 1,
                0,
                0,
                0,
            ).getTime();
            const stop = Math.min(end, next);
            perHour[cur.getHours()].set(
                p,
                (perHour[cur.getHours()].get(p) ?? 0) + (stop - t),
            );
            t = stop;
        }
    }
    const totals = perHour.map(aggTotal);
    const max = Math.max(...totals, 0);
    let peak = 0;
    for (let h = 1; h < 24; h++) if (totals[h] > totals[peak]) peak = h;
    const bars: StackBar[] = perHour.map((agg, h) => {
        const total = totals[h];
        const dom = dominant(agg);
        return {
            label: h % 6 === 0 ? hourLabel(h) : '',
            total,
            segments:
                total > 0
                    ? [
                          {
                              project: dom,
                              label: projectLabel(dom),
                              ms: total,
                              color: projectColor(dom),
                          },
                      ]
                    : [],
            labelMuted: true,
        };
    });
    return {
        bars,
        peakLabel: max > 0 ? `${hourLabel(peak)}–${hourLabel((peak + 1) % 24)}` : '—',
    };
}

// Average day, by weekday: each project's mean time on the weekdays it was
// worked. Denominator is the count of that weekday's tracked dates, so a bar
// reads as "a typical worked Tuesday".
export function buildWeekdayStacks(activities: Activity[]): {
    bars: StackBar[];
    legend: LegendItem[];
} {
    const index = dailyIndex(activities);
    const sums: DayAgg[] = Array.from({ length: 7 }, () => new Map());
    const counts = new Array<number>(7).fill(0);
    for (const [k, agg] of index) {
        const wd = getDay(parseDayKey(k));
        counts[wd] += 1;
        mergeInto(sums[wd], agg);
    }
    const jsOrder = [1, 2, 3, 4, 5, 6, 0];
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const avgAggs = jsOrder.map((wd) => {
        const out: DayAgg = new Map();
        const n = counts[wd] || 1;
        for (const [p, ms] of sums[wd]) out.set(p, ms / n);
        return out;
    });
    const order = orderOf(avgAggs);
    const bars: StackBar[] = avgAggs.map((agg, i) => ({
        label: labels[i],
        total: aggTotal(agg),
        segments: toSegments(agg, order),
    }));
    return { bars, legend: legendOf(avgAggs, order) };
}

export function buildTrend(
    activities: Activity[],
    weeks = 8,
    now = new Date(),
): { bars: StackBar[]; legend: LegendItem[] } {
    const index = dailyIndex(activities);
    const thisWeekStart = startOfWeek(now, WEEK_OPTS);
    const aggs: DayAgg[] = Array.from({ length: weeks }, () => new Map());
    const starts: Date[] = Array.from({ length: weeks }, (_, i) =>
        addWeeks(thisWeekStart, i - (weeks - 1)),
    );
    for (const [k, agg] of index) {
        const idx =
            weeks -
            1 -
            differenceInCalendarWeeks(thisWeekStart, parseDayKey(k), WEEK_OPTS);
        if (idx >= 0 && idx < weeks) mergeInto(aggs[idx], agg);
    }
    const order = orderOf(aggs);
    const bars: StackBar[] = aggs.map((agg, i) => {
        const isNow = i === weeks - 1;
        return {
            label: isNow ? 'Now' : format(starts[i], 'MMM d'),
            total: aggTotal(agg),
            segments: toSegments(agg, order),
            labelMuted: !isNow,
            pinned: isNow,
        };
    });
    return { bars, legend: legendOf(aggs, order) };
}

// ---- Stats ------------------------------------------------------------------

export type StatCard = { label: string; value: string; sub: string; accent?: string };
export type RecordRow = { label: string; value: string; when: string; icon: 'session' | 'day' | 'week' };
export type StreakDot = { label: string; level: number; color: string; tracked: boolean };

export type StatsData = {
    currentStreak: number;
    longestStreak: number;
    rangeStart: string;
    dots: StreakDot[];
    cards: StatCard[];
    records: RecordRow[];
    empty: boolean;
};

function contributionLevel(ms: number): number {
    if (ms <= 0) return 0;
    if (ms < 30 * MINUTE) return 1;
    if (ms < HOUR) return 2;
    if (ms < 2 * HOUR) return 3;
    return 4;
}

const STREAK_DOTS = 14;

export function buildStats(activities: Activity[], now = new Date()): StatsData {
    const index = dailyIndex(activities);

    let sessions = 0;
    let earliest: Date | null = null;
    let longestSession = 0;
    let longestSessionDay: Date | null = null;
    const durations: number[] = [];
    for (const a of activities) {
        const ms = durationMs(a);
        if (ms <= 0) continue;
        sessions += 1;
        durations.push(ms);
        const s = new Date(a.start_time as any);
        if (!earliest || s < earliest) earliest = s;
        if (ms > longestSession) {
            longestSession = ms;
            longestSessionDay = s;
        }
    }

    if (sessions === 0) {
        return {
            currentStreak: 0,
            longestStreak: 0,
            rangeStart: '',
            dots: [],
            cards: [],
            records: [],
            empty: true,
        };
    }

    const total = [...index.values()].reduce((s, agg) => s + aggTotal(agg), 0);
    const trackedDays = index.size;
    const hasDay = (d: Date) => index.has(dayKey(d));

    // Current streak: consecutive tracked days ending today (or yesterday, so a
    // day not yet worked doesn't read as broken until it's actually missed).
    let cursor = startOfDay(now);
    if (!hasDay(cursor)) cursor = subDays(cursor, 1);
    let currentStreak = 0;
    while (hasDay(cursor)) {
        currentStreak += 1;
        cursor = subDays(cursor, 1);
    }

    const sortedKeys = [...index.keys()].sort();
    let longestStreak = 0;
    let run = 0;
    let prevDate: Date | null = null;
    for (const k of sortedKeys) {
        const d = parseDayKey(k);
        run = prevDate && differenceInCalendarDays(d, prevDate) === 1 ? run + 1 : 1;
        if (run > longestStreak) longestStreak = run;
        prevDate = d;
    }

    const dots: StreakDot[] = [];
    for (let i = STREAK_DOTS - 1; i >= 0; i--) {
        const d = subDays(startOfDay(now), i);
        const agg = index.get(dayKey(d));
        const ms = agg ? aggTotal(agg) : 0;
        dots.push({
            label: format(d, 'MMM d'),
            level: contributionLevel(ms),
            color: agg ? projectColor(dominant(agg)) : '',
            tracked: ms > 0,
        });
    }

    let bestDay = 0;
    let bestDayKey = '';
    for (const [k, agg] of index) {
        const t = aggTotal(agg);
        if (t > bestDay) {
            bestDay = t;
            bestDayKey = k;
        }
    }
    const weekTotals = new Map<string, number>();
    for (const [k, agg] of index) {
        const wk = format(startOfWeek(parseDayKey(k), WEEK_OPTS), 'yyyy-MM-dd');
        weekTotals.set(wk, (weekTotals.get(wk) ?? 0) + aggTotal(agg));
    }
    let bestWeek = 0;
    let bestWeekKey = '';
    for (const [k, ms] of weekTotals) {
        if (ms > bestWeek) {
            bestWeek = ms;
            bestWeekKey = k;
        }
    }

    const spanDays = earliest
        ? differenceInCalendarDays(startOfDay(now), startOfDay(earliest)) + 1
        : 1;
    const spanWeeks = Math.max(1, spanDays / 7);
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const median = sortedDurations[Math.floor(sortedDurations.length / 2)] ?? 0;

    const weekday = buildWeekdayStacks(activities).bars;
    const bestWeekday = weekday.reduce(
        (best, b) => (b.total > best.total ? b : best),
        weekday[0] ?? { label: '—', total: 0, segments: [] },
    );
    const bestWeekdayColor = bestWeekday.segments[0]?.color;

    const thisWeek = buildReport(activities, 'weekly', 0, now);

    const cards: StatCard[] = [
        { label: 'Total tracked', value: fmt(total), sub: 'past year' },
        {
            label: 'Sessions',
            value: sessions.toLocaleString(),
            sub: `≈ ${Math.round(sessions / spanWeeks)} / week`,
        },
        {
            label: 'Daily average',
            value: fmt(total / trackedDays),
            sub: 'across tracked days',
        },
        {
            label: 'Avg session',
            value: fmt(total / sessions),
            sub: `${Math.round(median / MINUTE)}m median`,
        },
        {
            label: 'Most productive',
            value: bestWeekday.label,
            sub: `${fmt(bestWeekday.total)} avg`,
            accent: bestWeekdayColor,
        },
        {
            label: 'This week',
            value: fmt(thisWeek.totalMs),
            sub: thisWeek.hasPrev
                ? `${thisWeek.up ? '+' : '−'}${Math.abs(thisWeek.deltaPct)}% vs last`
                : 'no prior week',
        },
    ];

    const records: RecordRow[] = [
        {
            label: 'Longest single session',
            value: fmt(longestSession),
            when: longestSessionDay ? format(longestSessionDay, 'MMM d') : '',
            icon: 'session',
        },
        {
            label: 'Most in one day',
            value: fmt(bestDay),
            when: bestDayKey ? format(parseDayKey(bestDayKey), 'MMM d') : '',
            icon: 'day',
        },
        {
            label: 'Best week',
            value: fmt(bestWeek),
            when: bestWeekKey
                ? `week of ${format(parseDayKey(bestWeekKey), 'MMM d')}`
                : '',
            icon: 'week',
        },
    ];

    return {
        currentStreak,
        longestStreak,
        rangeStart: dots[0]?.label ?? '',
        dots,
        cards,
        records,
        empty: false,
    };
}
