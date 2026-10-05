import { FlashList } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { Check as CheckIcon, Plus, Search, Trash2, X } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, RefreshControl, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContributionGraph } from '@/components/ContributionGraph';
import { ContributionGraphSkeleton, LogRowsSkeleton } from '@/components/Skeletons';
import { EditActivityDialog, type ActivityEdit } from '@/components/EditActivityDialog';
import { EntryEditor, EntryMenu } from '@/components/EntryActions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { useEntries } from '@/lib/entries';
import { EASE_SIZE, enter } from '@/lib/motion';
import { useSession } from '@/lib/session';
import { dayLabel, formatClock, formatTotal, parseSyncTime } from '@/lib/time';
import { useTap } from '@/lib/use-tap';
import { cn } from '@/lib/utils';
import { dataToken } from '@/sync/account';
import { deleteEntries, pushEntries, syncTime, type Entry } from '@/sync/entries';

type DayItem = { kind: 'day'; key: string; title: string; total: number; ids: string[] };
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
            day = { kind: 'day', key, title: dayLabel(from), total: 0, ids: [] };
            headers.push(items.length);
            items.push(day);
        }
        day.total += to.getTime() - from.getTime();
        day.ids.push(entry.id);
        items.push({ kind: 'row', key: entry.id, entry, from, to });
    }
    return { items, headers };
}

const tabular = { fontVariant: ['tabular-nums' as const] };

// A ticked circle, drawn in as selection mode starts.
function Check({ on, partial = false }: { on: boolean; partial?: boolean }) {
    return (
        <Animated.View entering={enter({ scale: 0.6, duration: 200 })}>
            <View className={cn('size-[22px] items-center justify-center rounded-full border-2', on || partial ? 'border-foreground bg-foreground' : 'border-ring')}>
                {on ? <Icon as={CheckIcon} className="size-3.5 text-background" strokeWidth={3} /> : partial ? <View className="h-0.5 w-2.5 rounded-full bg-background" /> : null}
            </View>
        </Animated.View>
    );
}

const DayHeader = memo(function DayHeader({
    day,
    selecting,
    selected,
    onToggleDay,
}: {
    day: DayItem;
    selecting: boolean;
    selected: number;
    onToggleDay: (day: DayItem) => void;
}) {
    const { title, total } = day;
    if (selecting) {
        const all = selected === day.ids.length;
        return (
            // Keyed apart from the resting header: React would otherwise reuse
            // that Pressable, and the release of the hold that started
            // selecting would land here as a tap and untick the day.
            <Pressable
                key="selecting"
                onPress={() => onToggleDay(day)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: all ? true : selected ? 'mixed' : false }}
                accessibilityLabel={`Select all of ${title}`}
                className="flex-row items-center gap-3 border-b border-border bg-background px-5 pb-2.5 pt-7"
            >
                <Check on={all} partial={selected > 0 && !all} />
                <Text className="flex-1 font-sans-semibold text-[15px]">{title}</Text>
                <Text className="font-mono text-sm text-muted-foreground" style={tabular}>
                    {formatTotal(total)}
                </Text>
            </Pressable>
        );
    }
    // Holding a day starts selecting with the whole day ticked.
    return (
        <Pressable
            key="resting"
            onLongPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
                onToggleDay(day);
            }}
            accessibilityHint="Hold to select this day"
            className="flex-row items-baseline justify-between border-b border-border bg-background px-5 pb-2.5 pt-7"
        >
            <Text className="font-sans-semibold text-[15px]">{title}</Text>
            <Text className="font-mono text-sm text-muted-foreground" style={tabular}>
                {formatTotal(total)}
            </Text>
        </Pressable>
    );
});

const Row = memo(function Row({
    entry,
    from,
    to,
    selecting,
    selected,
    onPress,
    onToggle,
}: {
    entry: Entry;
    from: Date;
    to: Date;
    selecting: boolean;
    selected: boolean;
    onPress: (e: Entry) => void;
    onToggle: (e: Entry) => void;
}) {
    const tap = useTap(() => (selecting ? onToggle(entry) : onPress(entry)));
    const body = (
        <View className="flex-row items-center gap-3 border-b border-border/60">
            {selecting ? <Check on={selected} /> : null}
            <View className="flex-1 gap-1 py-3.5">
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
        </View>
    );
    if (selecting) {
        return (
            <Pressable
                {...tap}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                className={cn('px-5', selected ? 'bg-accent' : 'active:bg-accent')}
            >
                {body}
            </Pressable>
        );
    }
    return (
        <EntryMenu entry={entry} onEdit={() => onPress(entry)} onSelect={() => onToggle(entry)} {...tap} accessibilityRole="button" className="px-5 active:bg-accent">
            {body}
        </EntryMenu>
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
    const insets = useSafeAreaInsets();

    // Selection mode, entered from a row's long-press menu: rows and whole
    // days tick on tap, and the bar at the bottom deletes them together.
    const [selection, setSelection] = useState<Set<string> | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const selecting = selection !== null;
    const onToggle = useCallback((e: Entry) => {
        Haptics.selectionAsync().catch(() => undefined);
        setSelection((s) => {
            const next = new Set(s);
            if (next.has(e.id)) next.delete(e.id);
            else next.add(e.id);
            return next;
        });
    }, []);
    const onToggleDay = useCallback((day: DayItem) => {
        Haptics.selectionAsync().catch(() => undefined);
        setSelection((s) => {
            const next = new Set(s);
            const all = day.ids.every((id) => next.has(id));
            for (const id of day.ids) {
                if (all) next.delete(id);
                else next.add(id);
            }
            return next;
        });
    }, []);
    useEffect(() => {
        if (!selecting) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setSelection(null);
            return true;
        });
        return () => sub.remove();
    }, [selecting]);
    const chosen = useMemo(() => (entries ?? []).filter((e) => selection?.has(e.id)), [entries, selection]);
    const chosenMs = chosen.reduce((sum, e) => sum + parseSyncTime(e.end).getTime() - parseSyncTime(e.start).getTime(), 0);
    const removeChosen = async () => {
        setDeleting(true);
        try {
            await deleteEntries(await dataToken(), chosen.map((e) => e.id));
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
            setConfirming(false);
            setSelection(null);
            await load();
        } finally {
            setDeleting(false);
        }
    };

    const add = async (edit: ActivityEdit) => {
        if (!account) return;
        await pushEntries(await dataToken(), account.dek, account.user.id, [
            { description: edit.description, project: edit.project, start: `${edit.date} ${edit.start}`, end: `${edit.date} ${edit.end}` },
        ]);
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
                        {entries ? <ContributionGraph entries={entries} /> : <ContributionGraphSkeleton />}
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
                extraData={selection}
                contentContainerStyle={{ paddingBottom: selecting ? 120 + insets.bottom : 40 }}
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
                    item.kind === 'day' ? (
                        <DayHeader
                            day={item}
                            selecting={selecting}
                            selected={selection ? item.ids.filter((id) => selection.has(id)).length : 0}
                            onToggleDay={onToggleDay}
                        />
                    ) : (
                        <Row
                            entry={item.entry}
                            from={item.from}
                            to={item.to}
                            selecting={selecting}
                            selected={selection?.has(item.entry.id) ?? false}
                            onPress={onPress}
                            onToggle={onToggle}
                        />
                    )
                }
                ListEmptyComponent={
                    entries === null && !error ? (
                        <LogRowsSkeleton />
                    ) : (
                        <Text className="px-5 pt-10 text-center text-muted-foreground">{error || 'Nothing tracked yet. Stopped timers show up here.'}</Text>
                    )
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
            {editing ? <EntryEditor entry={editing} onClose={() => setEditing(null)} /> : null}
            {selecting ? (
                <Animated.View
                    entering={enter({ dy: 16, duration: 300, easing: EASE_SIZE })}
                    exiting={FadeOut.duration(150)}
                    style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
                >
                    <View className="flex-row items-center gap-2 border-t border-border bg-background px-5 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
                        <Button variant="ghost" size="icon" className="rounded-xl" onPress={() => setSelection(null)} accessibilityLabel="Stop selecting">
                            <Icon as={X} className="size-5 text-foreground" />
                        </Button>
                        <View className="flex-1">
                            <Text className="font-sans-semibold text-base">{chosen.length ? `${chosen.length} selected` : 'Select activities'}</Text>
                            <Text className="font-mono text-[13px] text-muted-foreground" style={tabular}>
                                {chosen.length ? formatTotal(chosenMs) : 'Tap rows or days'}
                            </Text>
                        </View>
                        <Button variant="destructive" className="h-11 rounded-xl px-4" disabled={chosen.length === 0} onPress={() => setConfirming(true)}>
                            <Icon as={Trash2} className="size-4 text-white" />
                            <Text>Delete</Text>
                        </Button>
                    </View>
                </Animated.View>
            ) : null}
            <Dialog open={confirming} onOpenChange={(open) => !deleting && setConfirming(open)}>
                <DialogContent className="w-[92vw] max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            Delete {chosen.length} {chosen.length === 1 ? 'activity' : 'activities'}?
                        </DialogTitle>
                        <DialogDescription>This removes {formatTotal(chosenMs)} from your log on every device. It can't be undone.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" disabled={deleting} onPress={() => setConfirming(false)}>
                            <Text>Cancel</Text>
                        </Button>
                        <Button variant="destructive" disabled={deleting} onPress={removeChosen}>
                            <Text>{deleting ? 'Deleting…' : 'Delete'}</Text>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </View>
    );
}
