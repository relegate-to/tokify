import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { formatTotal, parseSyncTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Entry } from '@/sync/entries';

// The desktop's ContributionGraph in its compact form: weeks of larger
// squares filling the width, each day tinted by its dominant project at an
// opacity that steps with the time logged.
const BLOCK = 15;
const GAP = 3;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OPACITY = [0, 0.32, 0.5, 0.72, 0.95];
const LEVEL_CLASS = ['bg-contribution-0', 'bg-contribution-1', 'bg-contribution-2', 'bg-contribution-3', 'bg-contribution-4'];

function level(ms: number) {
    if (ms === 0) return 0;
    if (ms < 30 * MINUTE) return 1;
    if (ms < HOUR) return 2;
    if (ms < 2 * HOUR) return 3;
    return 4;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function ContributionGraph({ entries }: { entries: Entry[] }) {
    const [width, setWidth] = useState(0);
    const weeks = Math.max(1, Math.floor((width + GAP) / (BLOCK + GAP)));

    const { columns, count, totalMs } = useMemo(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Columns run Sunday to Saturday, ending with this week.
        const start = new Date(today);
        start.setDate(today.getDate() - today.getDay() - 7 * (weeks - 1));
        const startKey = dayKey(start);
        const todayKey = dayKey(today);

        const days = new Map<string, Map<string, number>>();
        let n = 0;
        let total = 0;
        for (const e of entries) {
            const key = e.start.slice(0, 10);
            if (key < startKey || key > todayKey) continue;
            const ms = Math.max(0, parseSyncTime(e.end).getTime() - parseSyncTime(e.start).getTime());
            const projects = days.get(key) ?? new Map<string, number>();
            projects.set(e.project, (projects.get(e.project) ?? 0) + ms);
            days.set(key, projects);
            n += 1;
            total += ms;
        }

        const cols: { key: string; ms: number; project: string; future: boolean }[][] = [];
        const d = new Date(start);
        for (let w = 0; w < weeks; w++) {
            const col = [];
            for (let i = 0; i < 7; i++) {
                const key = dayKey(d);
                let ms = 0;
                let project = '';
                let top = 0;
                for (const [p, t] of days.get(key) ?? []) {
                    ms += t;
                    if (t > top) [top, project] = [t, p];
                }
                col.push({ key, ms, project, future: key > todayKey });
                d.setDate(d.getDate() + 1);
            }
            cols.push(col);
        }
        return { columns: cols, count: n, totalMs: total };
    }, [entries, weeks]);

    return (
        <Animated.View entering={FadeIn.duration(500)}>
            <View className="gap-3 rounded-2xl border border-subtle-surface-border bg-subtle-surface px-4 py-4">
                <View className="flex-row items-baseline justify-between">
                    <Text className="font-sans-semibold text-[15px]">Activity, past {weeks} weeks</Text>
                    <Text className="text-[13px] text-muted-foreground" style={{ fontVariant: ['tabular-nums'] }}>
                        {count.toLocaleString()} {count === 1 ? 'activity' : 'activities'} · {formatTotal(totalMs)}
                    </Text>
                </View>
                <View className="flex-row" style={{ gap: GAP }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
                    {width > 0 &&
                        columns.map((col) => (
                            <View key={col[0].key} style={{ gap: GAP }}>
                                {col.map((day) => (
                                    <View
                                        key={day.key}
                                        className={cn('rounded-[3px]', day.project ? projectColorClass(day.project) : LEVEL_CLASS[level(day.ms)])}
                                        style={{ width: BLOCK, height: BLOCK, opacity: day.future ? 0 : day.project ? OPACITY[level(day.ms)] : 1 }}
                                    />
                                ))}
                            </View>
                        ))}
                </View>
            </View>
        </Animated.View>
    );
}
