import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { ArrowLeft, Check, MoreHorizontal, Palette, Pencil, Trash2 } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { SafeAreaView } from '@/components/safe-area-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { PROJECT_PALETTE_SIZE, projectColorClass, projectIndex } from '@/lib/colors';
import { useEntries } from '@/lib/entries';
import { enter, LivePulse } from '@/lib/motion';
import { chooseColor, projectColors, useColorsVersion } from '@/lib/project-colors';
import { useRunningTimer } from '@/lib/running-timer';
import { useSession } from '@/lib/session';
import { formatTotal, parseSyncTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { dataToken } from '@/sync/account';
import { deleteEntries, renameProjectEntries } from '@/sync/entries';
import { removeProjectFromShares, renameProjectInShares } from '@/sync/sharing';
import { isRunning } from '@/sync/timer';

type Rollup = { ms: number; sessions: number; last: number };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The desktop's ProjectsView: every project in the history with its time,
// most recent first, and the running one on top. Color, rename and delete
// reach the whole history (and the teams it's shared with), not one entry.
export default function ProjectsScreen() {
    const { entries } = useEntries();
    const { state } = useRunningTimer();
    useColorsVersion();
    const running = isRunning(state.timer) ? state.timer.p : null;

    const rows = useMemo(() => {
        const stats = new Map<string, Rollup>();
        for (const e of entries ?? []) {
            if (!e.project) continue;
            const from = parseSyncTime(e.start).getTime();
            const cur = stats.get(e.project) ?? { ms: 0, sessions: 0, last: 0 };
            cur.ms += parseSyncTime(e.end).getTime() - from;
            cur.sessions += 1;
            cur.last = Math.max(cur.last, from);
            stats.set(e.project, cur);
        }
        if (running && !stats.has(running)) stats.set(running, { ms: 0, sessions: 0, last: Date.now() });
        return [...stats.entries()]
            .map(([name, roll]) => ({ name, roll }))
            .sort((a, b) => Number(b.name === running) - Number(a.name === running) || b.roll.last - a.roll.last || a.name.localeCompare(b.name));
    }, [entries, running]);
    const total = rows.reduce((sum, r) => sum + r.roll.ms, 0);

    return (
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
            <View className="flex-row items-center gap-1 px-2 pb-2 pt-1">
                <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" className="size-11 items-center justify-center rounded-xl active:bg-muted">
                    <Icon as={ArrowLeft} className="size-5 text-foreground" />
                </Pressable>
                <Text className="flex-1 font-sans-semibold text-[20px] tracking-[-0.4px]">Projects</Text>
                {rows.length ? (
                    <Text className="pr-3 font-mono text-[13px] text-muted-foreground" style={{ fontVariant: ['tabular-nums'] }}>
                        {rows.length} · {formatTotal(total)}
                    </Text>
                ) : null}
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="px-5 pb-10 pt-2">
                {entries === null ? (
                    <View className="flex-row items-center gap-2 py-2">
                        <ActivityIndicator size="small" />
                        <Text className="text-muted-foreground">Loading projects</Text>
                    </View>
                ) : rows.length === 0 ? (
                    <View className="items-center gap-1.5 py-8">
                        <Text className="font-sans-semibold text-base">No projects yet</Text>
                        <Text className="text-center text-sm text-muted-foreground">Pick a project when you start tracking and it shows up here.</Text>
                    </View>
                ) : (
                    <Animated.View entering={enter({ dy: -4, duration: 300 })}>
                        <View className="overflow-hidden rounded-2xl border border-border bg-card">
                            <View className="-mb-px">
                                {rows.map((r) => (
                                    <ProjectRow key={r.name} name={r.name} roll={r.roll} tracking={r.name === running} taken={rows.map((x) => x.name)} />
                                ))}
                            </View>
                        </View>
                    </Animated.View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function ProjectRow({ name, roll, tracking, taken }: { name: string; roll: Rollup; tracking: boolean; taken: string[] }) {
    const [dialog, setDialog] = useState<'color' | 'rename' | 'delete' | null>(null);
    const meta = roll.sessions
        ? `${roll.sessions} ${roll.sessions === 1 ? 'session' : 'sessions'} · last ${new Date(roll.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
        : 'Not tracked yet';
    return (
        <View className="flex-row items-center gap-3.5 border-b border-border/70 px-4 py-3">
            <Pressable onPress={() => setDialog('color')} accessibilityRole="button" accessibilityLabel={`Color for ${name}`} hitSlop={8}>
                <View className={cn('size-3.5 rounded-full', projectColorClass(name))} />
            </Pressable>
            <View className="flex-1 gap-0.5">
                <View className="flex-row items-center gap-2">
                    <Text numberOfLines={1} className="shrink font-sans-medium text-[15px]">
                        {name}
                    </Text>
                    {tracking ? (
                        <View className="flex-row items-center gap-1">
                            <LivePulse className="bg-live-dot" />
                            <Text className="font-sans-medium text-[11px] text-live-dot">tracking</Text>
                        </View>
                    ) : null}
                </View>
                <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
                    {meta}
                </Text>
            </View>
            <Text className="font-mono text-sm text-foreground/80" style={{ fontVariant: ['tabular-nums'] }}>
                {roll.sessions ? formatTotal(roll.ms) : '—'}
            </Text>
            <DropdownMenu>
                <DropdownMenuTrigger accessibilityLabel={`Actions for ${name}`} className="size-9 items-center justify-center rounded-lg active:bg-muted">
                    <Icon as={MoreHorizontal} className="size-4 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem onPress={() => setDialog('color')}>
                        <Icon as={Palette} className="size-4 text-foreground opacity-70" />
                        <Text>Color…</Text>
                    </DropdownMenuItem>
                    <DropdownMenuItem onPress={() => setDialog('rename')}>
                        <Icon as={Pencil} className="size-4 text-foreground opacity-70" />
                        <Text>Rename…</Text>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onPress={() => setDialog('delete')}>
                        <Icon as={Trash2} className="size-4 text-destructive opacity-70" />
                        <Text className="text-destructive">Delete…</Text>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <ColorDialog name={name} open={dialog === 'color'} onClose={() => setDialog(null)} />
            <RenameDialog name={name} taken={taken} tracking={tracking} open={dialog === 'rename'} onClose={() => setDialog(null)} />
            <DeleteDialog name={name} sessions={roll.sessions} open={dialog === 'delete'} onClose={() => setDialog(null)} />
        </View>
    );
}

function ColorDialog({ name, open, onClose }: { name: string; open: boolean; onClose: () => void }) {
    const { account } = useSession();
    const pinned = projectColors()[name]?.color ? projectIndex(name) : null;
    const pick = (i: number | null) => {
        if (!account) return;
        Haptics.selectionAsync().catch(() => undefined);
        chooseColor(account, name, i);
        onClose();
    };
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>Project color</DialogTitle>
                    <DialogDescription>Pick a color for {name}. It's used everywhere this project appears, on all your devices.</DialogDescription>
                </DialogHeader>
                <View className="flex-row flex-wrap gap-3 py-1">
                    {Array.from({ length: PROJECT_PALETTE_SIZE }, (_, i) => (
                        <Pressable
                            key={i}
                            onPress={() => pick(i)}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: pinned === i }}
                            className={cn('size-10 items-center justify-center rounded-full', `bg-project-${i}`, pinned === i && 'border-2 border-foreground/70')}
                        >
                            {pinned === i ? <Icon as={Check} className="size-4 text-white" /> : null}
                        </Pressable>
                    ))}
                </View>
                <DialogFooter className="flex-row items-center">
                    <Button variant="ghost" className="mr-auto px-2" onPress={() => pick(null)} disabled={pinned === null}>
                        <Text className="text-muted-foreground">Reset to automatic</Text>
                    </Button>
                    <Button variant="ghost" onPress={onClose}>
                        <Text>Done</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function RenameDialog({ name, taken, tracking, open, onClose }: { name: string; taken: string[]; tracking: boolean; open: boolean; onClose: () => void }) {
    const { account } = useSession();
    const { entries, reload } = useEntries();
    const { edit, state } = useRunningTimer();
    const [draft, setDraft] = useState(name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const next = draft.trim();

    const rename = async () => {
        if (!account || !entries || !next || next === name || busy) return;
        // As the desktop: renaming onto another project would fuse two histories.
        if (taken.includes(next)) return setError(`${next} already exists. Pick a different name.`);
        setBusy(true);
        setError('');
        try {
            await renameProjectEntries(await dataToken(), account.dek, account.user.id, entries, name, next);
            if (tracking && isRunning(state.timer)) await edit(state.timer.d, next);
            await renameProjectInShares(account, name, next).catch(() => undefined);
            const color = projectColors()[name];
            if (color?.color) {
                chooseColor(account, next, projectIndex(name));
                chooseColor(account, name, null);
            }
            await reload();
            onClose();
        } catch (e) {
            setError(message(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (o) return;
                setDraft(name);
                setError('');
                onClose();
            }}
        >
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>Rename project</DialogTitle>
                    <DialogDescription>This renames it across your whole history, and for any team you share it with.</DialogDescription>
                </DialogHeader>
                <Input value={draft} onChangeText={setDraft} onSubmitEditing={rename} autoFocus returnKeyType="done" />
                {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                <DialogFooter>
                    <Button variant="ghost" onPress={onClose} disabled={busy}>
                        <Text>Cancel</Text>
                    </Button>
                    <Button onPress={rename} disabled={busy || !next || next === name}>
                        {busy ? <ActivityIndicator size="small" color="white" /> : null}
                        <Text>Rename</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function DeleteDialog({ name, sessions, open, onClose }: { name: string; sessions: number; open: boolean; onClose: () => void }) {
    const { account } = useSession();
    const { entries, reload } = useEntries();
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const remove = async () => {
        if (!account || !entries || typed.trim() !== name || busy) return;
        setBusy(true);
        setError('');
        try {
            await deleteEntries(await dataToken(), entries.filter((e) => e.project === name).map((e) => e.id));
            await removeProjectFromShares(account, name).catch(() => undefined);
            if (projectColors()[name]?.color) chooseColor(account, name, null);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
            await reload();
            onClose();
        } catch (e) {
            setError(message(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (o) return;
                setTyped('');
                setError('');
                onClose();
            }}
        >
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>Delete project</DialogTitle>
                    <DialogDescription>
                        This permanently removes {sessions === 1 ? '1 session' : `${sessions} sessions`} from your history on every device, and stops sharing it.
                    </DialogDescription>
                </DialogHeader>
                <Text className="text-sm text-muted-foreground">
                    Type <Text className="font-sans-semibold text-sm text-foreground">{name}</Text> to confirm.
                </Text>
                <Input value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} />
                {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                <DialogFooter>
                    <Button variant="ghost" onPress={onClose} disabled={busy}>
                        <Text>Cancel</Text>
                    </Button>
                    <Button variant="destructive" onPress={remove} disabled={busy || typed.trim() !== name}>
                        {busy ? <ActivityIndicator size="small" color="white" /> : null}
                        <Text>Delete project</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
