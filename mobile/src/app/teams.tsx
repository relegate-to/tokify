import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { ArrowLeft, Check, LogOut, Mail, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';

import { MemberAvatar } from '@/components/MemberAvatar';
import { SafeAreaView } from '@/components/safe-area-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { useEntries } from '@/lib/entries';
import { enter } from '@/lib/motion';
import { useSession } from '@/lib/session';
import { reconcileSoon } from '@/lib/share-sync';
import { cn } from '@/lib/utils';
import { unlockSharing } from '@/sync/account';
import {
    acceptInvite,
    createTeam,
    deleteTeam,
    inviteByEmail,
    leaveTeam,
    listTeams,
    removeMember,
    renameTeam,
    setTeamShare,
    SharingLocked,
    teamShare,
    type ShareFilter,
    type Team,
    type TeamMember,
} from '@/sync/sharing';

// The desktop's TeamsView: invitations to accept, then each team with its
// people and what it shares. Everything here rides the sharing identity, which
// a phone signed in before sharing existed has to unlock once.
const SINCE_OPTIONS = [
    { label: 'Everything', value: 0 },
    { label: 'Last 30 days', value: 30 },
    { label: 'Last 7 days', value: 7 },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const shortId = (id: string) => (id.length <= 10 ? id : `…${id.slice(-6)}`);
const memberLabel = (m: TeamMember, self: boolean) => (self ? 'You' : m.displayName.trim() || shortId(m.userId));

function scopeSummary(share: (ShareFilter & { hasShare: boolean }) | null) {
    if (!share?.hasShare || share.projects.length === 0) return 'Not sharing any projects yet';
    const n = share.projects.length;
    return `${n} project${n === 1 ? '' : 's'} · ${share.sinceDays === 0 ? 'all history' : `last ${share.sinceDays} days`}`;
}

export default function TeamsScreen() {
    const { account } = useSession();
    const { entries } = useEntries();
    const [teams, setTeams] = useState<Team[] | null>(null);
    const [locked, setLocked] = useState(false);
    const [error, setError] = useState('');
    const [refreshing, setRefreshing] = useState(false);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    const load = useCallback(async () => {
        if (!account) return;
        try {
            setTeams(await listTeams(account));
            setLocked(false);
            setError('');
        } catch (e) {
            if (e instanceof SharingLocked) setLocked(true);
            else setError(message(e));
            setTeams((t) => t ?? []);
        }
    }, [account]);

    useEffect(() => {
        load();
    }, [load]);

    // A share or membership change re-grants this account's entries now
    // rather than at the next timed pass.
    const reconcileNow = useCallback(() => {
        if (account && entries) reconcileSoon(account, entries, true);
    }, [account, entries]);

    const create = async () => {
        if (!account || !newName.trim() || creating) return;
        setCreating(true);
        try {
            await createTeam(account, newName.trim());
            setNewName('');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
            await load();
        } catch (e) {
            setError(message(e));
        } finally {
            setCreating(false);
        }
    };

    const projects = useMemo(() => [...new Set((entries ?? []).map((e) => e.project).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [entries]);
    const pending = (teams ?? []).filter((t) => t.pending);
    const active = (teams ?? []).filter((t) => !t.pending);

    return (
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
            <View className="flex-row items-center gap-1 px-2 pb-2 pt-1">
                <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" className="size-11 items-center justify-center rounded-xl active:bg-muted">
                    <Icon as={ArrowLeft} className="size-5 text-foreground" />
                </Pressable>
                <Text className="flex-1 font-sans-semibold text-[20px] tracking-[-0.4px]">Teams</Text>
                <Pressable
                    onPress={async () => {
                        setRefreshing(true);
                        await load();
                        setRefreshing(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh teams"
                    className="size-11 items-center justify-center rounded-xl active:bg-muted"
                >
                    <Icon as={RefreshCw} className="size-[18px] text-muted-foreground" />
                </Pressable>
            </View>
            <KeyboardAwareScrollView
                showsVerticalScrollIndicator={false}
                contentContainerClassName="gap-5 px-5 pb-10 pt-2"
                keyboardShouldPersistTaps="handled"
                bottomOffset={24}
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
            >
                {locked ? (
                    <UnlockCard
                        onUnlock={async (password) => {
                            if (!account) return;
                            await unlockSharing(account, password);
                            await load();
                            reconcileNow();
                        }}
                    />
                ) : teams === null ? (
                    <View className="flex-row items-center gap-2 py-2">
                        <ActivityIndicator size="small" />
                        <Text className="text-muted-foreground">Loading teams</Text>
                    </View>
                ) : (
                    <>
                        <View className="flex-row items-center gap-2">
                            <Input value={newName} onChangeText={setNewName} onSubmitEditing={create} placeholder="Team name" returnKeyType="done" className="flex-1" editable={!creating} />
                            <Button className="h-12 rounded-lg" onPress={create} disabled={creating || !newName.trim()}>
                                {creating ? <ActivityIndicator size="small" color="white" /> : <Icon as={Plus} className="size-4 text-primary-foreground" />}
                                <Text>Create</Text>
                            </Button>
                        </View>
                        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                        {pending.length > 0 ? (
                            <View className="gap-2">
                                <Eyebrow>Invitations</Eyebrow>
                                {pending.map((t) => (
                                    <InviteCard
                                        key={t.id}
                                        team={t}
                                        onAccepted={async () => {
                                            await load();
                                            reconcileNow();
                                        }}
                                        onDeclined={() => setTeams((cur) => (cur ?? []).filter((x) => x.id !== t.id))}
                                    />
                                ))}
                            </View>
                        ) : null}
                        {active.length === 0 && pending.length === 0 ? (
                            <View className="items-center gap-1.5 py-8">
                                <Text className="font-sans-semibold text-base">No teams yet</Text>
                                <Text className="text-center text-sm text-muted-foreground">Create a team, add the people you work with, then choose which projects they can see.</Text>
                            </View>
                        ) : null}
                        {active.map((t, i) => (
                            <Animated.View key={t.id} entering={enter({ dy: -4, duration: 300, delay: i * 50 })}>
                                <TeamCard
                                    team={t}
                                    projects={projects}
                                    selfId={account?.user.id ?? ''}
                                    onChanged={load}
                                    onShareSaved={reconcileNow}
                                    onGone={() => setTeams((cur) => (cur ?? []).filter((x) => x.id !== t.id))}
                                />
                            </Animated.View>
                        ))}
                    </>
                )}
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}

function Eyebrow({ children }: { children: ReactNode }) {
    return <Text className="px-1 font-sans-medium text-xs uppercase tracking-[1px] text-muted-foreground">{children}</Text>;
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
    return <View className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</View>;
}

function UnlockCard({ onUnlock }: { onUnlock: (password: string) => Promise<void> }) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submit = async () => {
        if (!password || busy) return;
        setBusy(true);
        setError('');
        try {
            await onUnlock(password);
        } catch (e) {
            setError(message(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card className="gap-3">
            <View className="flex-row items-center gap-2">
                <Icon as={ShieldCheck} className="size-5 text-foreground" />
                <Text className="font-sans-semibold text-base">Unlock sharing</Text>
            </View>
            <Text className="text-sm leading-5 text-muted-foreground">
                Teams use your account's encrypted identity, which this phone hasn't unlocked yet. Enter your password once to set it up.
            </Text>
            <Input value={password} onChangeText={setPassword} onSubmitEditing={submit} placeholder="Password" secureTextEntry autoCapitalize="none" returnKeyType="go" />
            {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
            <Button onPress={submit} disabled={busy || !password} className="h-11 rounded-lg">
                {busy ? <ActivityIndicator size="small" color="white" /> : null}
                <Text>{busy ? 'Unlocking…' : 'Unlock'}</Text>
            </Button>
        </Card>
    );
}

function InviteCard({ team, onAccepted, onDeclined }: { team: Team; onAccepted: () => Promise<void>; onDeclined: () => void }) {
    const { account } = useSession();
    const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
    const [error, setError] = useState('');
    const act = async (kind: 'accept' | 'decline') => {
        if (!account || busy) return;
        setBusy(kind);
        setError('');
        try {
            if (kind === 'accept') {
                await acceptInvite(account, team.id);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
                await onAccepted();
            } else {
                await leaveTeam(account, team.id);
                onDeclined();
            }
        } catch (e) {
            setError(message(e));
            setBusy(null);
        }
    };
    return (
        <Card className="gap-3">
            <View className="flex-row items-center gap-3">
                <View className="size-9 items-center justify-center rounded-full bg-muted">
                    <Icon as={Mail} className="size-4 text-foreground opacity-70" />
                </View>
                <View className="flex-1 gap-0.5">
                    <Text className="text-[15px] leading-5">
                        You're invited to join <Text className="font-sans-semibold text-[15px]">{team.invitedBy.trim() || 'Someone'}'s team</Text>
                        {team.role === 'admin' ? ' as an admin' : ''}
                    </Text>
                    <Text className="text-[13px] text-muted-foreground">Accept to see what they share with the team.</Text>
                </View>
            </View>
            {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
            <View className="flex-row justify-end gap-2">
                <Button variant="ghost" size="sm" onPress={() => act('decline')} disabled={busy !== null}>
                    <Icon as={X} className="size-4 text-foreground" />
                    <Text>Decline</Text>
                </Button>
                <Button size="sm" onPress={() => act('accept')} disabled={busy !== null}>
                    {busy === 'accept' ? <ActivityIndicator size="small" color="white" /> : <Icon as={Check} className="size-4 text-primary-foreground" />}
                    <Text>Accept</Text>
                </Button>
            </View>
        </Card>
    );
}

function TeamCard({
    team,
    projects,
    selfId,
    onChanged,
    onShareSaved,
    onGone,
}: {
    team: Team;
    projects: string[];
    selfId: string;
    onChanged: () => Promise<void>;
    onShareSaved: () => void;
    onGone: () => void;
}) {
    const { account } = useSession();
    const isAdmin = team.role === 'admin';
    const [share, setShare] = useState<(ShareFilter & { hasShare: boolean }) | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [sinceDays, setSinceDays] = useState(0);
    const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [inviteEmail, setInviteEmail] = useState('');
    const [nameDraft, setNameDraft] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null);

    useEffect(() => {
        if (!account) return;
        teamShare(account, team.id)
            .then((s) => {
                setShare(s);
                setSelected(s.projects);
                setSinceDays(s.sinceDays);
            })
            .catch((e) => setNotice({ text: message(e), error: true }));
    }, [account, team.id]);

    const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
        if (!account || busy) return false;
        setBusy(key);
        setNotice(null);
        try {
            await fn();
            if (done) setNotice({ text: done });
            return true;
        } catch (e) {
            setNotice({ text: message(e), error: true });
            return false;
        } finally {
            setBusy(null);
        }
    };

    const shown = isAdmin ? [...new Set([...projects, ...selected])].sort((a, b) => a.localeCompare(b)) : [...(share?.projects ?? [])].sort((a, b) => a.localeCompare(b));
    const dirty = !!share && (share.sinceDays !== sinceDays || share.projects.length !== selected.length || share.projects.some((p) => !selected.includes(p)));
    const name = team.name || 'Untitled team';

    return (
        <Card className="gap-5">
            <View className="flex-row items-start gap-3">
                {team.members.length > 0 ? (
                    <View className="mt-0.5 flex-row">
                        {team.members.slice(0, 3).map((m, i) => (
                            <MemberAvatar key={m.userId} seed={m.userId} label={memberLabel(m, m.userId === selfId)} image={m.imageUrl} stacked={i > 0} />
                        ))}
                        {team.members.length > 3 ? (
                            <View className="-ml-2.5 size-8 items-center justify-center rounded-full border-2 border-card bg-muted">
                                <Text className="font-sans-medium text-[11px] text-muted-foreground">+{team.members.length - 3}</Text>
                            </View>
                        ) : null}
                    </View>
                ) : null}
                <View className="flex-1 gap-0.5">
                    {nameDraft !== null ? (
                        <TextInput
                            autoFocus
                            value={nameDraft}
                            onChangeText={setNameDraft}
                            onBlur={() => setNameDraft(null)}
                            onSubmitEditing={async () => {
                                const next = nameDraft.trim();
                                setNameDraft(null);
                                if (next && next !== team.name && account) await run('rename', () => renameTeam(account, team.id, next).then(onChanged));
                            }}
                            returnKeyType="done"
                            className="p-0 font-sans-semibold text-[17px] text-foreground"
                        />
                    ) : (
                        <Pressable onPress={() => setNameDraft(team.name)} accessibilityRole="button" accessibilityHint="Rename team">
                            <Text numberOfLines={1} className="font-sans-semibold text-[17px]">
                                {name}
                            </Text>
                        </Pressable>
                    )}
                    <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
                        {share ? scopeSummary(share) : 'Loading sharing…'}
                    </Text>
                </View>
                <View className="flex-row items-center gap-1">
                    <View className="rounded-md border border-border px-2 py-0.5">
                        <Text className="text-xs text-muted-foreground">{isAdmin ? 'Admin' : 'Member'}</Text>
                    </View>
                    <Pressable
                        onPress={() => setConfirm(team.createdBy === selfId ? 'delete' : 'leave')}
                        accessibilityRole="button"
                        accessibilityLabel={team.createdBy === selfId ? 'Delete team' : 'Leave team'}
                        className="size-9 items-center justify-center rounded-lg active:bg-muted"
                    >
                        <Icon as={team.createdBy === selfId ? Trash2 : LogOut} className="size-4 text-muted-foreground" />
                    </Pressable>
                </View>
            </View>

            <View className="gap-1">
                <Eyebrow>People</Eyebrow>
                {team.members.map((m) => {
                    const self = m.userId === selfId;
                    return (
                        <View key={m.userId} className="flex-row items-center gap-3 py-1.5">
                            <MemberAvatar seed={m.userId} label={memberLabel(m, self)} image={m.imageUrl} />
                            <Text numberOfLines={1} className="shrink text-[15px]">
                                {memberLabel(m, self)}
                            </Text>
                            <View className="rounded-md bg-secondary px-1.5 py-0.5">
                                <Text className="text-[11px] text-secondary-foreground">{m.role === 'admin' ? 'Admin' : 'Member'}</Text>
                            </View>
                            <View className="flex-1" />
                            {m.status === 'invited' ? (
                                <Status dot="bg-sky-400/80" text="invited" />
                            ) : self ? null : m.pinned ? (
                                <Icon as={ShieldCheck} className="size-4 text-emerald-500/80" accessibilityLabel="Verified on this phone" />
                            ) : (
                                <Status dot="bg-amber-400/80" text="unverified" />
                            )}
                            {isAdmin && !self ? (
                                <Pressable
                                    onPress={() => run(`remove:${m.userId}`, () => removeMember(account!, team.id, m.userId).then(onChanged), 'Removed from team')}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Remove ${memberLabel(m, false)}`}
                                    hitSlop={6}
                                    className="size-8 items-center justify-center rounded-lg active:bg-muted"
                                >
                                    {busy === `remove:${m.userId}` ? <ActivityIndicator size="small" /> : <Icon as={X} className="size-4 text-muted-foreground" />}
                                </Pressable>
                            ) : null}
                        </View>
                    );
                })}
                {isAdmin ? (
                    <View className="mt-2 flex-row items-center gap-2">
                        <Input
                            value={inviteEmail}
                            onChangeText={setInviteEmail}
                            placeholder="Invite by email"
                            keyboardType="email-address"
                            autoCapitalize="none"
                            autoCorrect={false}
                            className="h-11 flex-1"
                        />
                        <Button
                            variant="secondary"
                            className="h-11 rounded-lg"
                            disabled={!inviteEmail.trim() || busy !== null}
                            onPress={async () => {
                                const email = inviteEmail.trim();
                                if (await run('invite', () => inviteByEmail(account!, team.id, email).then(onChanged), `Invited ${email}`)) setInviteEmail('');
                            }}
                        >
                            {busy === 'invite' ? <ActivityIndicator size="small" /> : <Icon as={UserPlus} className="size-4 text-foreground" />}
                            <Text>Add</Text>
                        </Button>
                    </View>
                ) : null}
            </View>

            <View className="gap-3 border-t border-border pt-4">
                <Eyebrow>Shared projects</Eyebrow>
                {shown.length === 0 ? (
                    <Text className="text-sm text-muted-foreground">
                        {isAdmin ? 'No projects yet. Track some time first.' : 'This team is not sharing any projects yet.'}
                    </Text>
                ) : (
                    <View className="flex-row flex-wrap gap-1.5">
                        {shown.map((p) => {
                            const on = !isAdmin || selected.includes(p);
                            return (
                                <Pressable
                                    key={p}
                                    disabled={!isAdmin}
                                    onPress={() => {
                                        Haptics.selectionAsync().catch(() => undefined);
                                        setSelected((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
                                    }}
                                    accessibilityRole="checkbox"
                                    accessibilityState={{ checked: on }}
                                    className={cn('flex-row items-center gap-1.5 rounded-full border px-3 py-1.5', on ? 'border-transparent bg-secondary' : 'border-border')}
                                >
                                    <View className={cn('size-2 rounded-full', projectColorClass(p))} />
                                    <Text className={cn('text-[13px]', on ? 'text-secondary-foreground' : 'text-muted-foreground')}>{p}</Text>
                                    {on && isAdmin ? <Icon as={Check} className="size-3 text-secondary-foreground" /> : null}
                                </Pressable>
                            );
                        })}
                    </View>
                )}
                <View className="flex-row flex-wrap items-center gap-1.5">
                    <Text className="mr-1 text-[13px] text-muted-foreground">History</Text>
                    {SINCE_OPTIONS.map((o) => (
                        <Button key={o.value} size="sm" variant={sinceDays === o.value ? 'default' : 'outline'} disabled={!isAdmin} onPress={() => setSinceDays(o.value)} className="h-8 px-2.5">
                            <Text className="text-[13px]">{o.label}</Text>
                        </Button>
                    ))}
                </View>
                {isAdmin ? (
                    <Button
                        className="h-10 self-start rounded-lg"
                        disabled={!dirty || busy !== null}
                        onPress={() =>
                            run(
                                'share',
                                async () => {
                                    await setTeamShare(account!, team.id, { projects: selected, sinceDays });
                                    setShare({ projects: selected, sinceDays, hasShare: selected.length > 0 });
                                    onShareSaved();
                                },
                                selected.length ? 'Sharing updated' : 'Sharing cleared',
                            )
                        }
                    >
                        {busy === 'share' ? <ActivityIndicator size="small" color="white" /> : <Icon as={Check} className="size-4 text-primary-foreground" />}
                        <Text>Save sharing</Text>
                    </Button>
                ) : null}
            </View>
            {notice ? <Text className={cn('text-sm', notice.error ? 'text-destructive' : 'text-muted-foreground')}>{notice.text}</Text> : null}

            <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
                <DialogContent className="w-[92vw] max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {confirm === 'delete' ? 'Delete' : 'Leave'} {team.name || 'this team'}?
                        </DialogTitle>
                        <DialogDescription>
                            {confirm === 'delete'
                                ? "This deletes the team for everyone and stops sharing these projects. It can't be undone."
                                : "You'll stop seeing what this team shares, and they'll no longer see your shared projects."}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onPress={() => setConfirm(null)} disabled={busy !== null}>
                            <Text>Cancel</Text>
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={busy !== null}
                            onPress={async () => {
                                const ok = await run(confirm!, () => (confirm === 'delete' ? deleteTeam(account!, team.id) : leaveTeam(account!, team.id)));
                                setConfirm(null);
                                if (ok) onGone();
                            }}
                        >
                            <Text>{confirm === 'delete' ? 'Delete team' : 'Leave team'}</Text>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}

function Status({ dot, text }: { dot: string; text: string }) {
    return (
        <View className="flex-row items-center gap-1">
            <View className={cn('size-1.5 rounded-full', dot)} />
            <Text className="text-xs text-muted-foreground">{text}</Text>
        </View>
    );
}

