import { FlashList } from '@shopify/flash-list';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { useSession } from '@/lib/session';
import { dayLabel, formatClock, formatTotal, parseSyncTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { dataToken } from '@/sync/account';
import { listEntries, type Entry } from '@/sync/entries';

type DayItem = { kind: 'day'; key: string; title: string; total: number };
type Item = DayItem | { kind: 'row'; key: string; entry: Entry; from: Date; to: Date };

// Day headers and rows flattened into one recycled list; headers stick.
function flatten(entries: Entry[]) {
    const items: Item[] = [];
    const headers: number[] = [];
    let day = null as DayItem | null;
    for (const entry of entries) {
        const from = parseSyncTime(entry.start);
        const to = parseSyncTime(entry.end);
        const key = entry.start.slice(0, 10);
        if (day?.key !== key) {
            day = { kind: 'day', key, title: dayLabel(from), total: 0 };
            headers.push(items.length);
            items.push(day);
        }
        day.total += to.getTime() - from.getTime();
        items.push({ kind: 'row', key: entry.id, entry, from, to });
    }
    return { items, headers };
}

const tabular = { fontVariant: ['tabular-nums' as const] };

const DayHeader = memo(function DayHeader({ title, total }: { title: string; total: number }) {
    return (
        <View className="flex-row items-baseline justify-between border-b border-border bg-background px-5 pb-2 pt-6">
            <Text className="font-sans-semibold text-sm">{title}</Text>
            <Text className="font-mono text-[13px] text-muted-foreground" style={tabular}>
                {formatTotal(total)}
            </Text>
        </View>
    );
});

const Row = memo(function Row({ entry, from, to }: { entry: Entry; from: Date; to: Date }) {
    return (
        <View className="mx-5 gap-1 border-b border-border/60 py-3">
            <View className="flex-row items-center gap-2.5">
                <View className={cn('size-[7px] rounded-[2px]', projectColorClass(entry.project))} />
                <Text numberOfLines={1} className="flex-1 font-sans-medium text-[15px]">
                    {entry.description}
                </Text>
                <Text className="font-mono text-[13px] text-secondary-foreground" style={tabular}>
                    {formatTotal(to.getTime() - from.getTime())}
                </Text>
            </View>
            <Text numberOfLines={1} className="pl-[17px] text-[13px] text-ink-faint">
                {[entry.project, `${formatClock(from)}–${formatClock(to)}`].filter(Boolean).join('   ')}
            </Text>
        </View>
    );
});

// The synced history, newest first, grouped by day as on the desktop's Log.
export function LogPage() {
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

    const { items, headers } = useMemo(() => flatten(entries ?? []), [entries]);

    return (
        <View style={{ flex: 1 }}>
        <FlashList
            data={items}
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.kind}
            stickyHeaderIndices={headers}
            contentContainerStyle={{ paddingBottom: 40 }}
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
            renderItem={({ item }) =>
                item.kind === 'day' ? <DayHeader title={item.title} total={item.total} /> : <Row entry={item.entry} from={item.from} to={item.to} />
            }
            ListEmptyComponent={
                <Text className="px-5 pt-10 text-center text-muted-foreground">
                    {error || (entries === null ? 'Loading your history…' : 'Nothing tracked yet. Stopped timers show up here.')}
                </Text>
            }
        />
        </View>
    );
}
