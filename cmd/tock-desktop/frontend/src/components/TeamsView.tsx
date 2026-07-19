import { useEffect, useMemo, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Loader2,
    LogOut,
    Mail,
    Plus,
    RefreshCw,
    ShieldCheck,
    Trash2,
    UserPlus,
    X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    SharingAcceptInvite,
    SharingCreateTeam,
    SharingDeclineInvite,
    SharingDeleteTeam,
    SharingInviteByEmail,
    SharingLeaveTeam,
    SharingListTeams,
    SharingRemoveMember,
    SharingRenameTeam,
    SharingSetTeamShare,
    SharingTeamMembers,
    SharingTeamShare,
    SyncStatus,
} from '../../wailsjs/go/main/App';
import { main, neonsync } from '../../wailsjs/go/models';

import { authErrorText } from '@/lib/errors';
import { readInviteEmails, rememberInviteEmail } from '@/lib/invite-emails';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

// The team's history window maps straight to the share filter's since_days: it is
// the single control over how far back a team can see, and it applies to everyone
// in the team (see the share-not-invite model). 0 means the whole history.
const SINCE_OPTIONS = [
    { label: 'Everything', value: 0 },
    { label: 'Last 30 days', value: 30 },
    { label: 'Last 7 days', value: 7 },
];

function shortID(userID: string): string {
    return userID.length <= 10 ? userID : `…${userID.slice(-6)}`;
}

// A member's roster label prefers the name they published for themselves
// (identities.display_name). Before they've accepted they usually have none, so
// fall back to the email you invited them with, then a short id. The caller's own
// row always reads as "You".
function memberLabel(
    m: neonsync.TeamMember,
    self: boolean,
    emails: Record<string, string>,
): string {
    if (self) return 'You';
    return m.DisplayName.trim() || emails[m.UserID] || shortID(m.UserID);
}

function memberInitial(label: string): string {
    const c = label.trim()[0];
    return c ? c.toUpperCase() : '?';
}

function scopeSummary(share: neonsync.ShareView | null): string {
    if (!share || !share.HasShare || share.Projects.length === 0) {
        return 'Not sharing any projects yet';
    }
    const n = share.Projects.length;
    const window = share.SinceDays === 0 ? 'all history' : `last ${share.SinceDays} days`;
    return `${n} project${n === 1 ? '' : 's'} · ${window}`;
}

function inviteErrorText(e: unknown, email: string): string {
    const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
    if (msg.includes('no user found')) {
        return `${email} isn't on Tokify yet — share a link instead.`;
    }
    if (msg.includes('fingerprint changed')) {
        return `${email}'s security key changed — not added. Verify it before trying again.`;
    }
    return authErrorText(e);
}

// A tinted initial disc. The color is deterministic per user id (same hashing as
// project tags), so a person keeps one color everywhere they appear.
function Avatar({
    userID,
    label,
    stacked,
}: {
    userID: string;
    label: string;
    stacked?: boolean;
}) {
    const color = projectColor(userID);
    return (
        <span
            title={label}
            className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-card text-[11px] font-semibold',
                stacked && '-ml-2.5',
            )}
            style={{
                backgroundColor: `color-mix(in oklab, ${color} 22%, transparent)`,
                color,
            }}
        >
            {memberInitial(label)}
        </span>
    );
}

export function TeamsView({
    projects,
    selfUserID,
    onInviteResolved,
    onOpenAccount,
    onBack,
}: {
    projects: string[];
    selfUserID?: string;
    onInviteResolved?: (teamID: string) => void;
    onOpenAccount?: () => void;
    onBack: () => void;
}) {
    const [teams, setTeams] = useState<main.TeamView[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<neonsync.SyncStatus | null>(null);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    const load = () => {
        setLoading(true);
        // Teams ride the same encrypted identity as sync, so there's nothing to
        // list until the user has signed in and unlocked on this device. Gate the
        // team fetch on that — otherwise SharingListTeams fails reaching for a
        // Keychain item that isn't there and surfaces a raw "keychain item not
        // found" toast instead of pointing the user at Account.
        Promise.resolve(SyncStatus())
            .then((s) => {
                setStatus(s);
                if (!s?.configured || !s?.unlocked) {
                    setTeams([]);
                    return;
                }
                return SharingListTeams()
                    .then((t) => setTeams(t ?? []))
                    .catch((e) => {
                        setTeams([]);
                        toast.error(authErrorText(e));
                    });
            })
            .catch((e) => {
                setTeams([]);
                toast.error(authErrorText(e));
            })
            .finally(() => setLoading(false));
    };

    useEffect(load, []);

    const canManage = !!status?.configured && !!status?.unlocked;

    const pendingInvites = teams.filter((t) => t.Pending);
    const activeTeams = teams.filter((t) => !t.Pending);

    const createTeam = () => {
        const name = newName.trim();
        if (!name || creating) return;
        setCreating(true);
        SharingCreateTeam(name)
            .then((team) => {
                setTeams((cur) => [...cur, team]);
                setNewName('');
                toast.success(`Created ${team.Name}`);
            })
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setCreating(false));
    };

    const patchTeam = (id: string, patch: Partial<main.TeamView>) =>
        setTeams((cur) =>
            cur.map((t) => (t.ID === id ? ({ ...t, ...patch } as main.TeamView) : t)),
        );

    return (
        <div className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon-xs" onClick={onBack} title="Back">
                        <ArrowLeft />
                    </Button>
                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Teams
                    </h2>
                </div>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={load}
                    disabled={loading}
                    title="Refresh teams"
                >
                    <RefreshCw className={cn(loading && 'animate-spin')} />
                </Button>
            </div>

            {!loading && !canManage && (
                <Alert>
                    <ShieldCheck />
                    <AlertTitle>Sign in to use Teams</AlertTitle>
                    <AlertDescription className="flex flex-col items-start gap-3">
                        <span>
                            Teams use the same encrypted identity as sync. Sign in
                            and set up sync on this device to create or join a team.
                        </span>
                        {onOpenAccount && (
                            <Button size="sm" onClick={onOpenAccount}>
                                Go to Account
                            </Button>
                        )}
                    </AlertDescription>
                </Alert>
            )}

            {canManage && (
                <div className="flex items-center gap-2">
                    <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && createTeam()}
                        placeholder="Name a team — Design crew, Acme client…"
                        disabled={creating}
                    />
                    <Button
                        className="shrink-0"
                        onClick={createTeam}
                        disabled={creating || !newName.trim()}
                    >
                        {creating ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <Plus data-icon="inline-start" />
                        )}
                        Create team
                    </Button>
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="animate-spin" />
                    Loading teams
                </div>
            ) : teams.length === 0 ? (
                canManage && (
                    <Empty>
                        <EmptyHeader>
                            <EmptyTitle>No teams yet</EmptyTitle>
                            <EmptyDescription>
                                Create a team, add the people you work with, then
                                choose which projects they can see.
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )
            ) : (
                <div className="flex flex-col gap-4">
                    {pendingInvites.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                                Invitations
                            </div>
                            {pendingInvites.map((team) => (
                                <InviteCard
                                    key={team.ID}
                                    team={team}
                                    onResolved={(accepted) => {
                                        if (accepted) {
                                            load();
                                        } else {
                                            setTeams((cur) =>
                                                cur.filter((t) => t.ID !== team.ID),
                                            );
                                        }
                                        // Drop the masthead badge for this invite
                                        // right away rather than waiting on the poll.
                                        onInviteResolved?.(team.ID);
                                    }}
                                />
                            ))}
                        </div>
                    )}
                    {activeTeams.map((team) => (
                        <TeamCard
                            key={team.ID}
                            team={team}
                            projects={projects}
                            selfUserID={selfUserID}
                            onRenamed={(name) => patchTeam(team.ID, { Name: name })}
                            onMemberCountChange={(n) =>
                                patchTeam(team.ID, { MemberCount: n })
                            }
                            onDeleted={() =>
                                setTeams((cur) =>
                                    cur.filter((t) => t.ID !== team.ID),
                                )
                            }
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// A pending invitation: someone added this device's user to a team, but nothing
// of the team (roster, shared projects) is visible until the invite is accepted —
// so this card only offers Accept / Decline. Accepting flips membership to active
// and reloads the list, at which point the team renders as a full TeamCard.
function InviteCard({
    team,
    onResolved,
}: {
    team: main.TeamView;
    onResolved: (accepted: boolean) => void;
}) {
    const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
    const inviter = team.InvitedBy.trim() || 'Someone';
    const asAdmin = team.Role === 'admin';

    const accept = () => {
        if (busy) return;
        setBusy('accept');
        SharingAcceptInvite(team.ID)
            .then(() => {
                toast.success('Joined the team');
                onResolved(true);
            })
            .catch((e) => {
                toast.error(authErrorText(e));
                setBusy(null);
            });
    };

    const decline = () => {
        if (busy) return;
        setBusy('decline');
        SharingDeclineInvite(team.ID)
            .then(() => {
                toast.success('Invitation declined');
                onResolved(false);
            })
            .catch((e) => {
                toast.error(authErrorText(e));
                setBusy(null);
            });
    };

    return (
        <Card className="overflow-hidden">
            <CardContent className="flex items-center gap-4 p-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/70">
                    <Mail className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                        You're invited to join{' '}
                        <span className="font-medium">{inviter}'s team</span>
                        {asAdmin ? ' as an admin' : ''}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                        Accept to see what they share with the team.
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" onClick={accept} disabled={busy !== null}>
                        {busy === 'accept' ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <Check data-icon="inline-start" />
                        )}
                        Accept
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={decline}
                        disabled={busy !== null}
                        title="Decline invitation"
                    >
                        {busy === 'decline' ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <X data-icon="inline-start" />
                        )}
                        Decline
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

function TeamCard({
    team,
    projects,
    selfUserID,
    onRenamed,
    onMemberCountChange,
    onDeleted,
}: {
    team: main.TeamView;
    projects: string[];
    selfUserID?: string;
    onRenamed: (name: string) => void;
    onMemberCountChange: (count: number) => void;
    onDeleted: () => void;
}) {
    // The roster arrives with the team (SharingListTeams folds it in), so members
    // render immediately from the prop; only the share filter still loads per card.
    const [members, setMembers] = useState<neonsync.TeamMember[]>(
        team.Members ?? [],
    );
    const [share, setShare] = useState<neonsync.ShareView | null>(null);
    const [loading, setLoading] = useState(true);
    const [inviteEmails, setInviteEmails] = useState(readInviteEmails);

    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(team.Name);

    const [inviteEmail, setInviteEmail] = useState('');
    const [inviting, setInviting] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);

    const [selProjects, setSelProjects] = useState<string[]>([]);
    const [sinceDays, setSinceDays] = useState(0);
    const [savingShare, setSavingShare] = useState(false);

    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const [confirmLeave, setConfirmLeave] = useState(false);
    const [leaving, setLeaving] = useState(false);

    const isAdmin = team.Role === 'admin';

    const deleteTeam = () => {
        if (deleting) return;
        setDeleting(true);
        SharingDeleteTeam(team.ID)
            .then(() => {
                toast.success(`Deleted ${team.Name || 'team'}`);
                onDeleted();
            })
            .catch((e) => {
                toast.error(authErrorText(e));
                setDeleting(false);
                setConfirmDelete(false);
            });
    };

    const leaveTeam = () => {
        if (leaving) return;
        setLeaving(true);
        SharingLeaveTeam(team.ID)
            .then(() => {
                toast.success(`Left ${team.Name || 'team'}`);
                onDeleted();
            })
            .catch((e) => {
                toast.error(authErrorText(e));
                setLeaving(false);
                setConfirmLeave(false);
            });
    };

    const sortedProjects = useMemo(
        () => [...projects].filter(Boolean).sort((a, b) => a.localeCompare(b)),
        [projects],
    );

    // Admins pick which of their own projects to share, so they toggle over the
    // local project list. A member has no say and may not even own the shared
    // projects locally, so they see the team's actual shared set (share.Projects)
    // read-only — otherwise a project they don't track themselves is invisible.
    const displayProjects = useMemo(
        () =>
            isAdmin
                ? sortedProjects
                : [...(share?.Projects ?? [])]
                      .filter(Boolean)
                      .sort((a, b) => a.localeCompare(b)),
        [isAdmin, sortedProjects, share],
    );

    // Keep the roster in sync when the parent reloads teams (a fresh SharingListTeams
    // carries an updated Members slice).
    useEffect(() => {
        setMembers(team.Members ?? []);
    }, [team.Members]);

    const loadShare = () => {
        setLoading(true);
        SharingTeamShare(team.ID)
            .then((s) => {
                setShare(s);
                setSelProjects(s?.Projects ?? []);
                setSinceDays(s?.SinceDays ?? 0);
            })
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setLoading(false));
    };

    useEffect(loadShare, [team.ID]);

    // Refetch just the roster after a mutation that the folded-in prop won't reflect
    // until the parent reloads (inviting a new member).
    const refreshMembers = () =>
        SharingTeamMembers(team.ID)
            .then((m) => setMembers(m ?? []))
            .catch((e) => toast.error(authErrorText(e)));

    const invite = () => {
        const email = inviteEmail.trim();
        if (!email || inviting) return;
        setInviting(true);
        SharingInviteByEmail(team.ID, email, 'member')
            .then((userID) => {
                rememberInviteEmail(userID, email);
                setInviteEmails(readInviteEmails());
                setInviteEmail('');
                toast.success(`Invited ${email}`);
                refreshMembers();
            })
            .catch((e) => toast.error(inviteErrorText(e, email)))
            .finally(() => setInviting(false));
    };

    const remove = (userID: string) => {
        if (removing) return;
        setRemoving(userID);
        SharingRemoveMember(team.ID, userID)
            .then(() => {
                toast.success('Removed from team');
                setMembers((cur) => {
                    const next = cur.filter((m) => m.UserID !== userID);
                    onMemberCountChange(next.length);
                    return next;
                });
            })
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setRemoving(null));
    };

    const commitName = () => {
        const name = nameDraft.trim();
        setEditingName(false);
        if (!name || name === team.Name) {
            setNameDraft(team.Name);
            return;
        }
        SharingRenameTeam(team.ID, name)
            .then(() => {
                onRenamed(name);
                toast.success('Team renamed');
            })
            .catch((e) => {
                setNameDraft(team.Name);
                toast.error(authErrorText(e));
            });
    };

    const shareDirty = useMemo(() => {
        const cur = share?.Projects ?? [];
        const sameProjects =
            cur.length === selProjects.length &&
            cur.every((p) => selProjects.includes(p));
        return !sameProjects || (share?.SinceDays ?? 0) !== sinceDays;
    }, [share, selProjects, sinceDays]);

    const saveShare = () => {
        if (savingShare) return;
        setSavingShare(true);
        SharingSetTeamShare(team.ID, selProjects, sinceDays)
            .then(() => {
                setShare(
                    neonsync.ShareView.createFrom({
                        Projects: selProjects,
                        SinceDays: sinceDays,
                        HasShare: selProjects.length > 0,
                    }),
                );
                toast.success(
                    selProjects.length ? 'Sharing updated' : 'Sharing cleared',
                );
            })
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setSavingShare(false));
    };

    const toggleProject = (p: string) =>
        setSelProjects((cur) =>
            cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
        );

    return (
        <Card className="overflow-hidden">
            <CardContent className="flex flex-col gap-5 p-5">
                <div className="flex items-start gap-4">
                    {members.length > 0 && (
                        <div className="mt-0.5 flex items-center">
                            {members.slice(0, 4).map((m, i) => (
                                <Avatar
                                    key={m.UserID}
                                    userID={m.UserID}
                                    label={memberLabel(
                                        m,
                                        m.UserID === selfUserID,
                                        inviteEmails,
                                    )}
                                    stacked={i > 0}
                                />
                            ))}
                            {members.length > 4 && (
                                <span className="-ml-2.5 flex size-8 items-center justify-center rounded-full border-2 border-card bg-muted text-[11px] font-medium text-muted-foreground">
                                    +{members.length - 4}
                                </span>
                            )}
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        {editingName ? (
                            <Input
                                autoFocus
                                value={nameDraft}
                                onChange={(e) => setNameDraft(e.target.value)}
                                onBlur={commitName}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitName();
                                    if (e.key === 'Escape') {
                                        setNameDraft(team.Name);
                                        setEditingName(false);
                                    }
                                }}
                                className="h-8 max-w-[16rem] text-base font-semibold"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => {
                                    setNameDraft(team.Name);
                                    setEditingName(true);
                                }}
                                title="Rename team"
                                className="max-w-full truncate rounded text-left text-base font-semibold outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                                {team.Name || 'Untitled team'}
                            </button>
                        )}
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {loading ? 'Loading sharing…' : scopeSummary(share)}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="font-normal">
                            {isAdmin ? 'Admin' : 'Member'}
                        </Badge>
                        {isAdmin ? (
                            <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                                <DialogTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        title="Delete team"
                                    >
                                        <Trash2 />
                                    </Button>
                                </DialogTrigger>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle>
                                            Delete {team.Name || 'this team'}?
                                        </DialogTitle>
                                        <DialogDescription>
                                            This deletes the team for everyone and stops
                                            sharing these projects. It can't be undone.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <DialogFooter>
                                        <Button
                                            variant="ghost"
                                            onClick={() => setConfirmDelete(false)}
                                            disabled={deleting}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            onClick={deleteTeam}
                                            disabled={deleting}
                                        >
                                            {deleting && (
                                                <Loader2
                                                    data-icon="inline-start"
                                                    className="animate-spin"
                                                />
                                            )}
                                            Delete team
                                        </Button>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                        ) : (
                            <Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
                                <DialogTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        title="Leave team"
                                    >
                                        <LogOut />
                                    </Button>
                                </DialogTrigger>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle>
                                            Leave {team.Name || 'this team'}?
                                        </DialogTitle>
                                        <DialogDescription>
                                            You'll stop seeing what this team shares, and
                                            they'll no longer see your shared projects.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <DialogFooter>
                                        <Button
                                            variant="ghost"
                                            onClick={() => setConfirmLeave(false)}
                                            disabled={leaving}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            onClick={leaveTeam}
                                            disabled={leaving}
                                        >
                                            {leaving && (
                                                <Loader2
                                                    data-icon="inline-start"
                                                    className="animate-spin"
                                                />
                                            )}
                                            Leave team
                                        </Button>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                        )}
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        People
                    </div>
                    <div className="flex flex-col">
                        {members.map((m) => {
                            const self = m.UserID === selfUserID;
                            const label = memberLabel(m, self, inviteEmails);
                            const invited = m.Status === 'invited';
                            return (
                                <div
                                    key={m.UserID}
                                    className="group flex items-center gap-3 py-2"
                                >
                                    <Avatar userID={m.UserID} label={label} />
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                        <span className="min-w-0 truncate text-sm">
                                            {label}
                                        </span>
                                        <Badge
                                            variant="secondary"
                                            className="shrink-0 font-normal"
                                        >
                                            {m.Role === 'admin' ? 'Admin' : 'Member'}
                                        </Badge>
                                    </div>
                                    {invited ? (
                                        <span
                                            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                                            title="Invited — waiting for them to accept"
                                        >
                                            <span className="size-1.5 rounded-full bg-sky-400/80" />
                                            invited
                                        </span>
                                    ) : (
                                        !self &&
                                        (m.Pinned ? (
                                            <span
                                                className="inline-flex shrink-0"
                                                title="Verified on this device"
                                            >
                                                <ShieldCheck className="size-3.5 text-emerald-500/80" />
                                            </span>
                                        ) : (
                                            <span
                                                className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                                                title="Trusted on first use — key not verified on this device"
                                            >
                                                <span className="size-1.5 rounded-full bg-amber-400/80" />
                                                unverified
                                            </span>
                                        ))
                                    )}
                                    {isAdmin && !self && (
                                        <Button
                                            variant="ghost"
                                            size="icon-xs"
                                            className="-my-1 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                            disabled={removing === m.UserID}
                                            onClick={() => remove(m.UserID)}
                                            title="Remove from team"
                                        >
                                            {removing === m.UserID ? (
                                                <Loader2 className="animate-spin" />
                                            ) : (
                                                <Trash2 />
                                            )}
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {isAdmin && (
                        <div className="mt-1 flex items-center gap-2">
                            <Input
                                type="email"
                                value={inviteEmail}
                                onChange={(e) => setInviteEmail(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && invite()}
                                placeholder="Invite by email"
                                disabled={inviting}
                                className="h-8"
                            />
                            <Button
                                variant="secondary"
                                size="sm"
                                className="shrink-0"
                                onClick={invite}
                                disabled={inviting || !inviteEmail.trim()}
                            >
                                {inviting ? (
                                    <Loader2
                                        data-icon="inline-start"
                                        className="animate-spin"
                                    />
                                ) : (
                                    <UserPlus data-icon="inline-start" />
                                )}
                                Add
                            </Button>
                        </div>
                    )}
                </div>

                <Separator />

                <div className="flex flex-col gap-3">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Shared projects
                    </div>

                    {displayProjects.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {isAdmin
                                ? 'No projects yet. Track some time or create a project first.'
                                : 'This team is not sharing any projects yet.'}
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {displayProjects.map((p) => {
                                const on = isAdmin ? selProjects.includes(p) : true;
                                return (
                                    <button
                                        key={p}
                                        type="button"
                                        onClick={() => isAdmin && toggleProject(p)}
                                        disabled={!isAdmin}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                                            on
                                                ? 'border-transparent bg-secondary text-secondary-foreground'
                                                : 'bg-background text-muted-foreground hover:text-foreground',
                                            !isAdmin && 'cursor-default',
                                        )}
                                    >
                                        <span
                                            aria-hidden
                                            className="size-2 rounded-full"
                                            style={{ backgroundColor: projectColor(p) }}
                                        />
                                        {p}
                                        {on && <Check className="size-3" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">History</span>
                        {SINCE_OPTIONS.map((option) => (
                            <Button
                                key={option.value}
                                type="button"
                                variant={
                                    sinceDays === option.value ? 'default' : 'outline'
                                }
                                size="sm"
                                disabled={!isAdmin}
                                onClick={() => setSinceDays(option.value)}
                            >
                                {option.label}
                            </Button>
                        ))}
                    </div>

                    {isAdmin && (
                        <Button
                            className="self-start"
                            size="sm"
                            onClick={saveShare}
                            disabled={!shareDirty || savingShare}
                        >
                            {savingShare ? (
                                <Loader2
                                    data-icon="inline-start"
                                    className="animate-spin"
                                />
                            ) : (
                                <Check data-icon="inline-start" />
                            )}
                            Save sharing
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
