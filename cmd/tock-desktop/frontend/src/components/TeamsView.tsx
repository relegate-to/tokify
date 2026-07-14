import { useEffect, useMemo, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Loader2,
    Plus,
    RefreshCw,
    ShieldCheck,
    Trash2,
    UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    SharingCreateTeam,
    SharingDeleteTeam,
    SharingInviteByEmail,
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
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

// Contacts are a local, display-only convenience: the email you invited someone
// with, keyed by their user id, so the roster reads as people rather than opaque
// ids. It never leaves this device — the server only ever knows an email hash.
const CONTACTS_KEY = 'tokify.teamContacts';

function readContacts(): Record<string, string> {
    try {
        return JSON.parse(localStorage.getItem(CONTACTS_KEY) || '{}');
    } catch {
        return {};
    }
}

function rememberContact(userID: string, email: string) {
    try {
        const map = readContacts();
        map[userID] = email;
        localStorage.setItem(CONTACTS_KEY, JSON.stringify(map));
    } catch {
        // ignore
    }
}

function shortID(userID: string): string {
    return userID.length <= 10 ? userID : `…${userID.slice(-6)}`;
}

function memberLabel(
    userID: string,
    self: boolean,
    contacts: Record<string, string>,
): string {
    if (self) return 'You';
    return contacts[userID] || shortID(userID);
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
    onBack,
}: {
    projects: string[];
    selfUserID?: string;
    onBack: () => void;
}) {
    const [teams, setTeams] = useState<main.TeamView[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<neonsync.SyncStatus | null>(null);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    const load = () => {
        setLoading(true);
        Promise.all([SyncStatus(), SharingListTeams()])
            .then(([s, t]) => {
                setStatus(s);
                setTeams(t ?? []);
            })
            .catch((e) => {
                setTeams([]);
                toast.error(authErrorText(e));
            })
            .finally(() => setLoading(false));
    };

    useEffect(load, []);

    const canManage = !!status?.configured && !!status?.unlocked;

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
                    <AlertTitle>Sign in and unlock sync first</AlertTitle>
                    <AlertDescription>
                        Teams use the same encrypted identity as sync. Open Account,
                        sign in, and make sure sync is set up on this device.
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
                    {teams.map((team) => (
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
    const [members, setMembers] = useState<neonsync.TeamMember[]>([]);
    const [share, setShare] = useState<neonsync.ShareView | null>(null);
    const [loading, setLoading] = useState(true);
    const [contacts, setContacts] = useState(readContacts);

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

    const sortedProjects = useMemo(
        () => [...projects].filter(Boolean).sort((a, b) => a.localeCompare(b)),
        [projects],
    );

    const load = () => {
        setLoading(true);
        Promise.all([SharingTeamMembers(team.ID), SharingTeamShare(team.ID)])
            .then(([m, s]) => {
                setMembers(m ?? []);
                setShare(s);
                setSelProjects(s?.Projects ?? []);
                setSinceDays(s?.SinceDays ?? 0);
            })
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setLoading(false));
    };

    useEffect(load, [team.ID]);

    const invite = () => {
        const email = inviteEmail.trim();
        if (!email || inviting) return;
        setInviting(true);
        SharingInviteByEmail(team.ID, email, 'member')
            .then((userID) => {
                rememberContact(userID, email);
                setContacts(readContacts());
                setInviteEmail('');
                toast.success(`Added ${email}`);
                load();
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
                    {!loading && members.length > 0 && (
                        <div className="mt-0.5 flex items-center">
                            {members.slice(0, 4).map((m, i) => (
                                <Avatar
                                    key={m.UserID}
                                    userID={m.UserID}
                                    label={memberLabel(
                                        m.UserID,
                                        m.UserID === selfUserID,
                                        contacts,
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
                                className="h-7 max-w-[16rem] text-sm font-semibold"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => {
                                    setNameDraft(team.Name);
                                    setEditingName(true);
                                }}
                                title="Rename team"
                                className="max-w-full truncate rounded text-left text-sm font-semibold outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                                {team.Name || 'Untitled team'}
                            </button>
                        )}
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {scopeSummary(share)}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="font-normal">
                            {isAdmin ? 'Admin' : 'Member'}
                        </Badge>
                        {isAdmin &&
                            (confirmDelete ? (
                                <div className="flex items-center gap-1">
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        disabled={deleting}
                                        onClick={deleteTeam}
                                    >
                                        {deleting && (
                                            <Loader2
                                                data-icon="inline-start"
                                                className="animate-spin"
                                            />
                                        )}
                                        Delete team
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={deleting}
                                        onClick={() => setConfirmDelete(false)}
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            ) : (
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => setConfirmDelete(true)}
                                    title="Delete team"
                                >
                                    <Trash2 />
                                </Button>
                            ))}
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        People
                    </div>
                    {loading ? (
                        <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            Loading
                        </div>
                    ) : (
                        <div className="flex flex-col">
                            {members.map((m) => {
                                const self = m.UserID === selfUserID;
                                const label = memberLabel(m.UserID, self, contacts);
                                return (
                                    <div
                                        key={m.UserID}
                                        className="group flex items-center gap-3 py-1.5"
                                    >
                                        <Avatar userID={m.UserID} label={label} />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm">
                                                {label}
                                            </div>
                                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                <span>
                                                    {m.Role === 'admin'
                                                        ? 'Admin'
                                                        : 'Member'}
                                                </span>
                                                {!self &&
                                                    (m.Pinned ? (
                                                        <span
                                                            className="inline-flex items-center gap-1"
                                                            title="Verified on this device"
                                                        >
                                                            <ShieldCheck className="size-3 text-emerald-500/80" />
                                                        </span>
                                                    ) : (
                                                        <span
                                                            className="inline-flex items-center gap-1"
                                                            title="Trusted on first use — key not verified on this device"
                                                        >
                                                            <span className="size-1.5 rounded-full bg-amber-400/80" />
                                                            <span>unverified</span>
                                                        </span>
                                                    ))}
                                            </div>
                                        </div>
                                        {isAdmin && !self && (
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                className="opacity-0 transition-opacity group-hover:opacity-100"
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
                    )}

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

                    {sortedProjects.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No projects yet. Track some time or create a project first.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {sortedProjects.map((p) => {
                                const on = selProjects.includes(p);
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
                                    sinceDays === option.value ? 'secondary' : 'outline'
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
