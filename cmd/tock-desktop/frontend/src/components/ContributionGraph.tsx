import { cloneElement, useMemo } from 'react';
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
import { formatTotal } from '@/lib/time';
import {
    Card,
    CardAction,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

const GRAPH_DAYS = 365;
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

export function ContributionGraph({ activities }: { activities: Activity[] }) {
    const todayKey = format(new Date(), 'yyyy-MM-dd');
    const { data, dominantProjects, totalMs, activityCount } = useMemo(() => {
        const end = startOfDay(new Date());
        const start = subDays(end, GRAPH_DAYS - 1);
        const startKey = format(start, 'yyyy-MM-dd');
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

            const key = format(activityStart, 'yyyy-MM-dd');
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
                const date = format(day, 'yyyy-MM-dd');
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
    }, [activities, todayKey]);

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
                    Activity, past year
                </CardTitle>
                <CardAction className="text-xs tabular-nums text-muted-foreground">
                    {activityCount.toLocaleString()}{' '}
                    {activityCount === 1 ? 'activity' : 'activities'}
                    <span className="mx-1.5 opacity-40">·</span>
                    {formatTotal(totalMs)} logged
                </CardAction>
            </CardHeader>
            <CardContent className="px-3">
                <ActivityCalendar
                    className="tokify-contribution-calendar"
                    data={data}
                    blockMargin={2.25}
                    blockRadius={2}
                    blockSize={10}
                    fontSize={12}
                    labels={{
                        legend: { less: 'Less', more: 'More' },
                    }}
                    renderBlock={(block, activity) => {
                        const project = dominantProjects.get(activity.date);
                        if (!project) return block;
                        return cloneElement(block, {
                            fill: projectColor(project),
                            fillOpacity: CONTRIBUTION_OPACITY[activity.level],
                        });
                    }}
                    showTotalCount={false}
                    showWeekdayLabels={['mon', 'wed', 'fri']}
                    theme={{
                        light: CONTRIBUTION_COLORS,
                        dark: CONTRIBUTION_COLORS,
                    }}
                    tooltips={{
                        activity: {
                            text: (activity) =>
                                `${formatTotal(activity.count)} on ${format(
                                    parseISO(activity.date),
                                    'EEEE, MMM d',
                                )}`,
                        },
                    }}
                />
            </CardContent>
        </Card>
    );
}
