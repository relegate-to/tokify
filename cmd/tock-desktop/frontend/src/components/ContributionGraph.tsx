import {
    cloneElement,
    memo,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
    eachDayOfInterval,
    format,
    parseISO,
    startOfDay,
    subDays,
} from 'date-fns';
import {
    ActivityCalendar,
    type Activity as CalendarActivity,
} from 'react-activity-calendar';

import type { Activity } from '@/types';
import { projectColor } from '@/lib/colors';
import { formatTotal, localDayKey } from '@/lib/time';
import { useCompact } from '@/lib/compact';
import {
    Card,
    CardAction,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

const GRAPH_DAYS = 365;
// The popover is too narrow for a year of 10px squares; this many weeks of
// larger ones fill its width instead.
const COMPACT_WEEKS = 20;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CONTRIBUTION_COLORS = [
    'var(--contribution-0)',
    'var(--contribution-1)',
    'var(--contribution-2)',
    'var(--contribution-3)',
    'var(--contribution-4)',
];
const CONTRIBUTION_OPACITY = [0, 0.32, 0.5, 0.72, 0.95];

function contributionLevel(ms: number) {
    if (ms === 0) return 0;
    if (ms < 30 * MINUTE) return 1;
    if (ms < HOUR) return 2;
    if (ms < 2 * HOUR) return 3;
    return 4;
}

export const ContributionGraph = memo(function ContributionGraph({ activities }: { activities: Activity[] }) {
    const compact = useCompact();
    const todayKey = localDayKey(new Date());
    const { data, dominantProjects, totalMs, activityCount } = useMemo(() => {
        const end = startOfDay(new Date());
        const start = subDays(end, (compact ? COMPACT_WEEKS * 7 : GRAPH_DAYS) - 1);
        const startKey = localDayKey(start);
        const durations = new Map<string, number>();
        const projectDurations = new Map<string, Map<string, number>>();
        let count = 0;

        for (const activity of activities) {
            if (!activity.end_time) continue;
            const activityStart = new Date(activity.start_time as any);
            const activityEnd = new Date(activity.end_time as any);
            const duration = Math.max(
                0,
                activityEnd.getTime() - activityStart.getTime(),
            );
            if (!Number.isFinite(duration)) continue;

            const key = localDayKey(activityStart);
            if (key < startKey || key > todayKey) continue;
            count += 1;
            durations.set(key, (durations.get(key) ?? 0) + duration);

            const project = activity.project ?? '';
            const dailyProjects = projectDurations.get(key) ?? new Map();
            dailyProjects.set(
                project,
                (dailyProjects.get(project) ?? 0) + duration,
            );
            projectDurations.set(key, dailyProjects);
        }

        let total = 0;
        const dominantByDate = new Map<string, string>();
        const calendarData: CalendarActivity[] = eachDayOfInterval({ start, end }).map(
            (day) => {
                const date = localDayKey(day);
                const count = durations.get(date) ?? 0;
                const dailyProjects = projectDurations.get(date);
                if (dailyProjects) {
                    let dominantProject = '';
                    let dominantDuration = 0;
                    for (const [project, duration] of dailyProjects) {
                        if (duration > dominantDuration) {
                            dominantProject = project;
                            dominantDuration = duration;
                        }
                    }
                    if (dominantProject) {
                        dominantByDate.set(date, dominantProject);
                    }
                }
                total += count;
                return {
                    date,
                    count,
                    level: contributionLevel(count),
                };
            },
        );

        return {
            data: calendarData,
            dominantProjects: dominantByDate,
            totalMs: total,
            activityCount: count,
        };
    }, [activities, todayKey, compact]);

    const cellTip = useCellTooltip();

    return (
        <Card
            role="region"
            aria-labelledby="contribution-graph-title"
            className="animate-in bg-subtle-surface ring-subtle-surface-border fade-in-0 [--card-spacing:1.25rem] duration-500"
        >
            <CardHeader>
                <CardTitle
                    id="contribution-graph-title"
                    className="text-sm font-semibold"
                >
                    {compact
                        ? `Activity, past ${COMPACT_WEEKS} weeks`
                        : 'Activity, past year'}
                </CardTitle>
                <CardAction className="text-xs tabular-nums text-muted-foreground">
                    {activityCount.toLocaleString()}{' '}
                    {activityCount === 1 ? 'activity' : 'activities'}
                    <span className="mx-1.5 opacity-40">·</span>
                    {formatTotal(totalMs)} logged
                </CardAction>
            </CardHeader>
            <CardContent
                className="px-3"
                onMouseOver={cellTip.onMouseOver}
                onMouseLeave={cellTip.hide}
            >
                <ActivityCalendar
                    className="tokify-contribution-calendar"
                    data={data}
                    blockMargin={compact ? 3 : 2.25}
                    blockRadius={compact ? 3 : 2}
                    blockSize={compact ? 15 : 10}
                    fontSize={12}
                    labels={{
                        legend: { less: 'Less', more: 'More' },
                    }}
                    renderBlock={(block, activity) => {
                        const project = dominantProjects.get(activity.date);
                        const props = {
                            'data-date': activity.date,
                            'data-count': activity.count,
                            ...(project && {
                                fill: projectColor(project),
                                fillOpacity: CONTRIBUTION_OPACITY[activity.level],
                            }),
                        };
                        return cloneElement(block, props);
                    }}
                    showTotalCount={false}
                    showWeekdayLabels={['mon', 'wed', 'fri']}
                    theme={{
                        light: CONTRIBUTION_COLORS,
                        dark: CONTRIBUTION_COLORS,
                    }}
                />
                {cellTip.tip &&
                    createPortal(<CellTooltip {...cellTip.tip} />, document.body)}
            </CardContent>
        </Card>
    );
});

const TIP_REST_MS = 150;
const TIP_GAP = 6;
const TIP_EDGE = 8;

type Tip = { text: string; x: number; y: number };

// One tooltip for the whole calendar. The library's own gives each of the 365
// cells a floating-ui instance with hover, dismiss and transition hooks, which
// was most of the graph's render cost on every edit. Here the cells only carry
// data attributes, and hovering reads whichever cell is under the pointer.
function useCellTooltip() {
    const [tip, setTip] = useState<Tip | null>(null);
    const shown = useRef(false);
    const rest = useRef<number | null>(null);

    const clearRest = () => {
        if (rest.current !== null) window.clearTimeout(rest.current);
        rest.current = null;
    };

    const hide = () => {
        clearRest();
        shown.current = false;
        setTip(null);
    };

    const onMouseOver = (e: MouseEvent) => {
        const cell = (e.target as Element).closest?.('rect[data-date]');
        if (!cell) return;
        const date = cell.getAttribute('data-date') ?? '';
        const count = Number(cell.getAttribute('data-count')) || 0;
        const r = cell.getBoundingClientRect();
        const next = {
            text: `${formatTotal(count)} on ${format(parseISO(date), 'EEEE, MMM d')}`,
            x: r.left + r.width / 2,
            y: r.top,
        };
        clearRest();
        // Once one is up, moving across cells follows at once; only the first
        // waits for the pointer to settle.
        if (shown.current) {
            setTip(next);
            return;
        }
        rest.current = window.setTimeout(() => {
            shown.current = true;
            setTip(next);
        }, TIP_REST_MS);
    };

    useEffect(() => {
        if (!tip) return;
        window.addEventListener('scroll', hide, true);
        return () => window.removeEventListener('scroll', hide, true);
    }, [tip]);

    useEffect(() => clearRest, []);

    return { tip, onMouseOver, hide };
}

function CellTooltip({ text, x, y }: Tip) {
    const ref = useRef<HTMLDivElement>(null);

    // Centered over the cell, but held inside the window at the year's edges.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const half = el.offsetWidth / 2;
        const left = Math.min(
            Math.max(x, half + TIP_EDGE),
            window.innerWidth - half - TIP_EDGE,
        );
        el.style.left = `${left}px`;
    }, [text, x]);

    return (
        <div
            ref={ref}
            role="tooltip"
            className="react-activity-calendar__tooltip pointer-events-none fixed z-50 animate-in fade-in-0 duration-150"
            style={{ left: x, top: y - TIP_GAP, transform: 'translate(-50%, -100%)' }}
        >
            {text}
        </div>
    );
}
