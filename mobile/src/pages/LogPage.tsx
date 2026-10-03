import { FlashList } from '@shopify/flash-list';
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';

import { Plus, Search } from 'lucide-react-native';

import { ContributionGraph } from '@/components/ContributionGraph';
import { EditActivityDialog, type ActivityEdit } from '@/components/EditActivityDialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { useEntries } from '@/lib/entries';
import { useSession } from '@/lib/session';
import { dayLabel, formatClock, formatTotal, parseSyncTime } from '@/lib/time';
import { useTap } from '@/lib/use-tap';
import { cn } from '@/lib/utils';
import { dataToken } from '@/sync/account';
import { deleteEntries, editEntry, pushEntries, syncTime, type Entry } from '@/sync/entries';

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
        <View className="flex-row items-baseline justify-between border-b border-border bg-background px-5 pb-2.5 pt-7">
            <Text className="font-sans-semibold text-[15px]">{title}</Text>
            <Text className="font-mono text-sm text-muted-foreground" style={tabular}>
                {formatTotal(total)}
            </Text>
        </View>
    );
});

const Row = memo(function Row({ entry, from, to, onPress }: { entry: Entry; from: Date; to: Date; onPress: (e: Entry) => void }) {
    const tap = useTap(() => onPress(entry));
    return (
        <Pressable {...tap} accessibilityRole="button" className="px-5 active:bg-accent">
            <View className="gap-1 border-b border-border/60 py-3.5">
                <View className="flex-row items-center gap-2.5">
                    <View className={cn('size-2 rounded-[2px]', projectColorClass(entry.project))} />
                    <Text numberOfLines={1} className="flex-1 font-sans-medium text-base">
                        {entry.description}
                    </Text>
                    <Text className="font-mono text-sm text-secondary-foreground" style={tabular}>
                        {formatTotal(to.getTime() - from.getTime())}
                    </Text>
                </View>
                <Text numberOfLines={1} className="pl-[18px] text-sm text-ink-faint">
                    {[entry.project, `${formatClock(from)}–${formatClock(to)}`].filter(Boolean).join('   ')}
                </Text>
            </View>
        </Pressable>
    );
});

// The synced history, newest first, grouped by day as on the desktop's Log.
export function LogPage() {
    const { account } = useSession();
    const { entries, error, reload: load } = useEntries();
    const [refreshing, setRefreshing] = useState(false);
    const [editing, setEditing] = useState<Entry | null>(null);
    const [adding, setAdding] = useState(false);
    const [query, setQuery] = useState('');
    const projects = useMemo(() => [...new Set((entries ?? []).map((e) => e.project).filter(Boolean))], [entries]);
    const onPress = useCallback((e: Entry) => setEditing(e), []);

    const save = async (edit: ActivityEdit) => {
        if (!account || !editing) return;
        await editEntry(await dataToken(), account.dek, account.user.id, editing, {
            description: edit.description,
            project: edit.project,
            start: `${editing.start.slice(0, 10)} ${edit.start}`,
            end: `${editing.end.slice(0, 10)} ${edit.end}`,
        });
        await load();
    };

    const add = async (edit: ActivityEdit) => {
        if (!account) return;
        await pushEntries(await dataToken(), account.dek, account.user.id, [
            { description: edit.description, project: edit.project, start: `${edit.date} ${edit.start}`, end: `${edit.date} ${edit.end}` },
        ]);
        await load();
    };

    const remove = async () => {
        if (!editing) return;
        await deleteEntries(await dataToken(), [editing.id]);
        await load();
    };

    // As the desktop's Log search: description or project, case-insensitive.
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        const all = entries ?? [];
        return q ? all.filter((e) => e.description.toLowerCase().includes(q) || e.project.toLowerCase().includes(q)) : all;
    }, [entries, query]);
    const { items, headers } = useMemo(() => flatten(shown), [shown]);
    const now = new Date();

    return (
        <View style={{ flex: 1 }}>
            <FlashList
                data={items}
                keyExtractor={(item) => item.key}
                getItemType={(item) => item.kind}
                stickyHeaderIndices={headers}
                ListHeaderComponent={
                    <View className="gap-3 px-5 pt-2">
                        {entries ? <ContributionGraph entries={entries} /> : null}
                        <View className="flex-row items-center gap-2">
                            <View className="h-11 flex-1 flex-row items-center gap-2 rounded-xl border border-subtle-surface-border bg-subtle-surface px-3">
                                <Icon as={Search} className="size-4 text-muted-foreground opacity-60" />
                                <Input
                                    value={query}
                                    onChangeText={setQuery}
                                    placeholder="Search description or project"
                                    returnKeyType="search"
                                    autoCorrect={false}
                                    className="h-10 flex-1 border-0 bg-transparent px-0"
                                />
                            </View>
                            <Button variant="outline" className="h-11 rounded-xl px-3" onPress={() => setAdding(true)} accessibilityLabel="Add past activity">
                                <Icon as={Plus} className="size-4 text-foreground" />
                                <Text>Add past</Text>
                            </Button>
                        </View>
                    </View>
                }
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
                    item.kind === 'day' ? <DayHeader title={item.title} total={item.total} /> : <Row entry={item.entry} from={item.from} to={item.to} onPress={onPress} />
                }
                ListEmptyComponent={
                    <Text className="px-5 pt-10 text-center text-muted-foreground">
                        {error || (entries === null ? 'Loading your history…' : 'Nothing tracked yet. Stopped timers show up here.')}
                    </Text>
                }
            />
            <EditActivityDialog
                open={adding}
                onOpenChange={setAdding}
                title="Add past activity"
                saveLabel="Add activity"
                subtitle="For time you tracked without the timer."
                initial={{ description: '', project: projects[0] ?? '', date: syncTime(now).slice(0, 10), start: '', end: '' }}
                projects={projects}
                onSave={add}
            />
            {editing ? (
                <EditActivityDialog
                    open
                    onOpenChange={(open) => !open && setEditing(null)}
                    subtitle={`Tracked ${parseSyncTime(editing.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}.`}
                    initial={{ description: editing.description, project: editing.project, start: editing.start.slice(11), end: editing.end.slice(11) }}
                    projects={projects}
                    onSave={save}
                    onDelete={remove}
                />
            ) : null}
        </View>
    );
}
