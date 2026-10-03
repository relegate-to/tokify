import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';

import { SafeAreaView } from '@/components/safe-area-view';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { useSession } from '@/lib/session';
import { dayLabel, formatClock, formatTotal, parseSyncTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { dataToken } from '@/sync/account';
import { listEntries, type Entry } from '@/sync/entries';

type Row = Entry & { from: Date; to: Date };
type Day = { title: string; total: number; data: Row[] };

function byDay(entries: Entry[]): Day[] {
    const days = new Map<string, Day>();
    for (const e of entries) {
        const from = parseSyncTime(e.start);
        const to = parseSyncTime(e.end);
        const key = e.start.slice(0, 10);
        const day = days.get(key) ?? { title: dayLabel(from), total: 0, data: [] };
        day.total += to.getTime() - from.getTime();
        day.data.push({ ...e, from, to });
        days.set(key, day);
    }
    return [...days.values()];
}

// The synced history, newest first, grouped by day as on the desktop's Log.
export default function LogScreen() {
    const { account } = useSession();
    const [entries, setEntries] = useState<Entry[] | null>(null);
    const [error, setError] = useState('');
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async () => {
        if (!account) return;
        try {
            setEntries(await listEntries(await dataToken(), account.dek, account.user.id));
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [account]);

    useEffect(() => {
        load();
    }, [load]);

    const sections = useMemo(() => byDay(entries ?? []), [entries]);

    return (
        <SafeAreaView className="flex-1 bg-background" edges={['top']}>
            <View className="flex-row items-center justify-between px-5 pb-2 pt-6">
                <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8}>
                    <Text className="text-sm text-muted-foreground">Now</Text>
                </Pressable>
                <Text className="font-sans-semibold text-lg tracking-[-0.2px]">Log</Text>
                <View className="w-8" />
            </View>
            <SectionList
                sections={sections}
                keyExtractor={(row) => row.id}
                stickySectionHeadersEnabled
                contentContainerClassName="px-5 pb-10"
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={async () => {
                            setRefreshing(true);
                            await load();
                            setRefreshing(false);
                        }}
                    />
                }
                renderSectionHeader={({ section }) => (
                    <View className="flex-row items-baseline justify-between border-b border-border bg-background pb-2 pt-6">
                        <Text className="font-sans-semibold text-sm">{section.title}</Text>
                        <Text className="font-mono text-[13px] text-muted-foreground" style={{ fontVariant: ['tabular-nums'] }}>
                            {formatTotal(section.total)}
                        </Text>
                    </View>
                )}
                renderItem={({ item }) => (
                    <View className="gap-1 border-b border-border/60 py-3">
                        <View className="flex-row items-center gap-2.5">
                            <View className={cn('size-[7px] rounded-[2px]', projectColorClass(item.project))} />
                            <Text numberOfLines={1} className="flex-1 font-sans-medium text-[15px]">
                                {item.description}
                            </Text>
                            <Text className="font-mono text-[13px] text-secondary-foreground" style={{ fontVariant: ['tabular-nums'] }}>
                                {formatTotal(item.to.getTime() - item.from.getTime())}
                            </Text>
                        </View>
                        <Text numberOfLines={1} className="pl-[17px] text-[13px] text-ink-faint">
                            {[item.project, `${formatClock(item.from)}–${formatClock(item.to)}`].filter(Boolean).join('   ')}
                        </Text>
                    </View>
                )}
                ListEmptyComponent={
                    <Text className="pt-10 text-center text-muted-foreground">
                        {error || (entries === null ? 'Loading your history…' : 'Nothing tracked yet. Stopped timers show up here.')}
                    </Text>
                }
            />
        </SafeAreaView>
    );
}
