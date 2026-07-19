import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Loader2,
    MoreHorizontal,
    Palette,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    Users,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    CreateProject,
    DeleteProject,
    ListProjects,
    RenameProject,
    SetProjectColor,
} from '../../wailsjs/go/main/App';
import type { projects } from '../../wailsjs/go/models';

import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { PROJECT_COLORS, projectColor } from '@/lib/colors';
import { durationMs } from '@/lib/summary';
import { dayLabel, formatTotal, startOfDay } from '@/lib/time';
import { ProjectSharesContext } from '@/lib/project-shares';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';

// Per-project rollup over the local year: time tracked, how many sessions, and
// when it was last touched. Drives the row meta and the recency sort.
type Rollup = { ms: number; sessions: number; last: number };

const HIGHLIGHT_MS = 2000;

export function ProjectsView({
    activities,
    running,
    onChanged,
    onBack,
}: {
    activities: Activity[];
    running: Activity | null;
    // Told after a rename or color change so App can reload the color overrides and
    // re-fetch the activity data, which is also what refreshes a renamed project's
    // stats under its new name.
    onChanged: () => void;
    onBack: () => void;
}) {
    const shares = useContext(ProjectSharesContext);
    const [catalog, setCatalog] = useState<projects.Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [highlight, setHighlight] = useState<string | null>(null);
    // Carries a renamed project's rollup to its new name until the re-fetched
    // activities catch up, so the row shows its sessions immediately instead of
    // flashing "Not tracked yet" while the log rewrite propagates back.
    const [statsOverride, setStatsOverride] = useState<Record<string, Rollup>>({});
    const highlightRef = useRef<HTMLDivElement>(null);

    const load = () => {
        setLoading(true);
        ListProjects()
            .then((list) => setCatalog(list ?? []))
            .catch((e) => toast.error(String(e)))
            .finally(() => setLoading(false));
    };

    useEffect(load, []);

    // Reveal a just-created or just-renamed project (recency sort drops untracked
    // ones to the bottom) and let its ring fade on its own.
    useEffect(() => {
        if (!highlight) return;
        highlightRef.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
        });
        const t = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
        return () => window.clearTimeout(t);
    }, [highlight]);

    // Fresh activity data already reflects any rename, so the transient carry can
    // be dropped the moment it lands.
    useEffect(() => setStatsOverride({}), [activities]);

    const stats = useMemo(() => {
        const m = new Map<string, Rollup>();
        for (const a of activities) {
            const name = a.project ?? '';
            if (!name) continue;
            const cur = m.get(name) ?? { ms: 0, sessions: 0, last: 0 };
            cur.ms += durationMs(a);
            cur.sessions += 1;
            const start = new Date(a.start_time as any).getTime();
            if (start > cur.last) cur.last = start;
            m.set(name, cur);
        }
        return m;
    }, [activities]);

    const rows = useMemo(() => {
        return [...catalog]
            .map((project) => ({
                project,
                roll: stats.get(project.name) ?? statsOverride[project.name],
            }))
            .sort((a, b) => {
                const ra = running?.project === a.project.name ? 1 : 0;
                const rb = running?.project === b.project.name ? 1 : 0;
                if (ra !== rb) return rb - ra;
                const la = a.roll?.last ?? 0;
                const lb = b.roll?.last ?? 0;
                if (la !== lb) return lb - la;
                return a.project.name.localeCompare(b.project.name);
            });
    }, [catalog, stats, statsOverride, running]);

    const totalMs = useMemo(
        () => catalog.reduce((sum, p) => sum + (stats.get(p.name)?.ms ?? 0), 0),
        [catalog, stats],
    );

    const create = () => {
        const name = newName.trim();
        if (!name || creating) return;
        setCreating(true);
        CreateProject(name)
            .then((p) => {
                setCatalog((cur) =>
                    cur.some((x) => x.name === p.name) ? cur : [...cur, p],
                );
                setNewName('');
                setHighlight(p.name);
                toast.success(`Created ${p.name}`);
            })
            .catch((e) => toast.error(String(e)))
            .finally(() => setCreating(false));
    };

    // Returns a promise so the rename dialog can stay open until the rewrite
    // actually lands and only close on success. Rethrows so a failure keeps the
    // dialog up for the user to retry.
    const rename = (oldName: string, nextName: string): Promise<void> => {
        const next = nextName.trim();
        if (!next || next === oldName) return Promise.resolve();
        return RenameProject(oldName, next)
            .then((p) => {
                setCatalog((cur) =>
                    cur
                        .filter((x) => x.name !== p.name)
                        .map((x) => (x.name === oldName ? p : x)),
                );
                const carried = stats.get(oldName);
                if (carried) {
                    setStatsOverride((cur) => ({ ...cur, [p.name]: carried }));
                }
                setHighlight(p.name);
                toast.success(`Renamed to ${p.name}`);
                onChanged();
            })
            .catch((e) => {
                toast.error(String(e));
                throw e;
            });
    };

    const setColor = (name: string, color: string): Promise<void> => {
        return SetProjectColor(name, color)
            .then((p) => {
                setCatalog((cur) => cur.map((x) => (x.name === name ? p : x)));
                toast.success(color ? 'Color updated' : 'Color reset');
                onChanged();
            })
            .catch((e) => {
                toast.error(String(e));
                throw e;
            });
    };

    // Returns a promise so the confirm dialog can stay open until the rows are
    // actually gone and only close on success; rethrows so a failure keeps the
    // dialog up to retry.
    const remove = (name: string): Promise<void> => {
        return DeleteProject(name)
            .then(() => {
                setCatalog((cur) => cur.filter((x) => x.name !== name));
                toast.success(`Deleted ${name}`);
                onChanged();
            })
            .catch((e) => {
                toast.error(String(e));
                throw e;
            });
    };

    return (
        <div className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon-xs" onClick={onBack} title="Back">
                        <ArrowLeft />
                    </Button>
                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Projects
                    </h2>
                </div>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={load}
                    disabled={loading}
                    title="Refresh projects"
                >
                    <RefreshCw className={cn(loading && 'animate-spin')} />
                </Button>
            </div>

            {catalog.length > 0 && (
                <p className="-mt-3 text-sm text-muted-foreground">
                    {catalog.length} {catalog.length === 1 ? 'project' : 'projects'}
                    {totalMs > 0 && ` · ${formatTotal(totalMs)} tracked in the past year`}
                </p>
            )}

            <div className="flex items-center gap-2">
                <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && create()}
                    placeholder="project name"
                    disabled={creating}
                />
                <Button
                    className="shrink-0"
                    onClick={create}
                    disabled={creating || !newName.trim()}
                >
                    {creating ? (
                        <Loader2 data-icon="inline-start" className="animate-spin" />
                    ) : (
                        <Plus data-icon="inline-start" />
                    )}
                    Create project
                </Button>
            </div>

            {loading ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="animate-spin" />
                    Loading projects
                </div>
            ) : rows.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyTitle>No projects yet</EmptyTitle>
                        <EmptyDescription>
                            Name a project to line up work before you start the
                            clock. It lives here even before you track any time.
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <Card className="overflow-hidden">
                    <CardContent className="p-0">
                        <div className="divide-y">
                            {rows.map(({ project, roll }) => (
                                <ProjectRow
                                    key={project.name}
                                    rowRef={
                                        project.name === highlight
                                            ? highlightRef
                                            : undefined
                                    }
                                    name={project.name}
                                    color={project.color}
                                    roll={roll}
                                    sharedWith={shares[project.name]?.Members?.length ?? 0}
                                    running={running?.project === project.name}
                                    highlighted={project.name === highlight}
                                    onRename={rename}
                                    onSetColor={setColor}
                                    onDelete={remove}
                                />
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function ProjectRow({
    rowRef,
    name,
    color,
    roll,
    sharedWith,
    running,
    highlighted,
    onRename,
    onSetColor,
    onDelete,
}: {
    rowRef?: React.Ref<HTMLDivElement>;
    name: string;
    color?: string;
    roll?: Rollup;
    sharedWith: number;
    running: boolean;
    highlighted: boolean;
    onRename: (oldName: string, nextName: string) => Promise<void>;
    onSetColor: (name: string, color: string) => Promise<void>;
    onDelete: (name: string) => Promise<void>;
}) {
    const [renameOpen, setRenameOpen] = useState(false);
    const [colorOpen, setColorOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);

    const meta = roll
        ? `${roll.sessions} ${roll.sessions === 1 ? 'session' : 'sessions'} · ${dayLabel(
              startOfDay(new Date(roll.last)),
          )}`
        : 'Not tracked yet';

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        ref={rowRef}
                        className={cn(
                            'group flex items-center gap-3.5 px-4 py-3 transition-colors',
                            highlighted && 'bg-muted/50',
                        )}
                    >
                        <ProjectDisc name={name} />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">
                                    {name}
                                </span>
                                {running && (
                                    <span
                                        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                                        title="Currently tracking"
                                    >
                                        <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                                        tracking
                                    </span>
                                )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span className="truncate">{meta}</span>
                                {sharedWith > 0 && (
                                    <span
                                        className="inline-flex shrink-0 items-center gap-1"
                                        title={`Shared with ${sharedWith} ${sharedWith === 1 ? 'person' : 'people'}`}
                                    >
                                        <span aria-hidden>·</span>
                                        <Users className="size-3" />
                                        {sharedWith}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <span className="text-sm tabular-nums text-foreground/80">
                                {roll ? formatTotal(roll.ms) : '—'}
                            </span>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                                        title="Project actions"
                                    >
                                        <MoreHorizontal />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                        onSelect={() => setRenameOpen(true)}
                                    >
                                        <Pencil className="size-4 opacity-70" />
                                        Rename…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onSelect={() => setColorOpen(true)}
                                    >
                                        <Palette className="size-4 opacity-70" />
                                        Color…
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        className="text-destructive data-[highlighted]:text-destructive"
                                        onSelect={() => setDeleteOpen(true)}
                                    >
                                        <Trash2 className="size-4 opacity-70" />
                                        Delete…
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onSelect={() => setRenameOpen(true)}>
                        <Pencil className="size-4 opacity-70" />
                        Rename…
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => setColorOpen(true)}>
                        <Palette className="size-4 opacity-70" />
                        Color…
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        className="text-destructive data-[highlighted]:text-destructive"
                        onSelect={() => setDeleteOpen(true)}
                    >
                        <Trash2 className="size-4 opacity-70" />
                        Delete…
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>

            <RenameProjectDialog
                open={renameOpen}
                onOpenChange={setRenameOpen}
                name={name}
                shared={sharedWith > 0}
                onRename={onRename}
            />
            <ProjectColorDialog
                open={colorOpen}
                onOpenChange={setColorOpen}
                name={name}
                current={color ?? ''}
                onPick={onSetColor}
            />
            <DeleteProjectDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                name={name}
                roll={roll}
                shared={sharedWith > 0}
                onDelete={onDelete}
            />
        </>
    );
}

// Rename is not a light touch — it rewrites every logged entry and re-points the
// share filters of anyone the project reaches — so it lives in a deliberate dialog
// rather than an inline edit. The dialog stays open through the whole operation:
// the fields lock while it runs and it only dismisses once the rewrite lands, so a
// failure leaves the draft in place to retry.
function RenameProjectDialog({
    open,
    onOpenChange,
    name,
    shared,
    onRename,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    shared: boolean;
    onRename: (oldName: string, nextName: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState(name);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setDraft(name);
            setBusy(false);
        }
    }, [open, name]);

    const next = draft.trim();
    const canRename = !busy && next.length > 0 && next !== name;

    const submit = () => {
        if (busy) return;
        if (!next || next === name) {
            onOpenChange(false);
            return;
        }
        setBusy(true);
        onRename(name, next)
            .then(() => onOpenChange(false))
            .catch(() => setBusy(false));
    };

    return (
        <Dialog
            open={open}
            // Hold the dialog open while the rewrite is in flight; a stray backdrop
            // click or Escape must not abandon a half-finished rename.
            onOpenChange={(nextOpen) => {
                if (busy) return;
                onOpenChange(nextOpen);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Rename project</DialogTitle>
                    <DialogDescription>
                        This renames it across your whole history
                        {shared ? ' and updates it for everyone you share it with' : ''}.
                    </DialogDescription>
                </DialogHeader>
                <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                    placeholder="Project name"
                    disabled={busy}
                />
                <DialogFooter>
                    <Button
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={!canRename}>
                        {busy && (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        )}
                        {busy ? 'Renaming…' : 'Rename'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// Pin a project's color from the app's own palette, or reset it to the automatic
// name-derived color. Applying picks and closes; the swatch shows a spinner while
// its write is in flight so the choice reads as committed, not just selected.
function ProjectColorDialog({
    open,
    onOpenChange,
    name,
    current,
    onPick,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    current: string;
    onPick: (name: string, color: string) => Promise<void>;
}) {
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        if (open) setBusy(null);
    }, [open]);

    const pick = (color: string) => {
        if (busy !== null) return;
        setBusy(color || 'auto');
        onPick(name, color)
            .then(() => onOpenChange(false))
            .catch(() => setBusy(null));
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (busy !== null) return;
                onOpenChange(next);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Project color</DialogTitle>
                    <DialogDescription>
                        Pick a color for {name}. It's used everywhere this project
                        appears.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-wrap gap-2.5 py-1">
                    {PROJECT_COLORS.map((c) => {
                        const selected = current === c;
                        return (
                            <button
                                key={c}
                                type="button"
                                onClick={() => pick(c)}
                                disabled={busy !== null}
                                title={selected ? 'Current color' : 'Use this color'}
                                aria-pressed={selected}
                                className={cn(
                                    'flex size-9 items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-background transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default',
                                    selected && 'ring-2 ring-foreground/70',
                                )}
                                style={{ backgroundColor: c }}
                            >
                                {busy === c ? (
                                    <Loader2 className="size-4 animate-spin text-white/90" />
                                ) : (
                                    selected && (
                                        <Check className="size-4 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]" />
                                    )
                                )}
                            </button>
                        );
                    })}
                </div>
                <DialogFooter className="sm:justify-between">
                    <button
                        type="button"
                        onClick={() => pick('')}
                        disabled={busy !== null || !current}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                        {busy === 'auto' && (
                            <Loader2 className="size-3 animate-spin" />
                        )}
                        Reset to automatic color
                    </button>
                    <Button
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                        disabled={busy !== null}
                    >
                        Done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// Deleting a project erases its rows for good, so the dialog makes the blast
// radius explicit and gates the action behind retyping the exact project name —
// there is no undo. Like rename, it stays open through the delete and only
// dismisses once the rows are gone, so a failure leaves the confirmation intact.
function DeleteProjectDialog({
    open,
    onOpenChange,
    name,
    roll,
    shared,
    onDelete,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    roll?: Rollup;
    shared: boolean;
    onDelete: (name: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setDraft('');
            setBusy(false);
        }
    }, [open]);

    const confirmed = draft.trim() === name;
    const canDelete = !busy && confirmed;

    const submit = () => {
        if (!canDelete) return;
        setBusy(true);
        onDelete(name)
            .then(() => onOpenChange(false))
            .catch(() => setBusy(false));
    };

    const scope = roll
        ? `${roll.sessions} ${roll.sessions === 1 ? 'session' : 'sessions'} (${formatTotal(roll.ms)})`
        : null;

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (busy) return;
                onOpenChange(nextOpen);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Delete project</DialogTitle>
                    <DialogDescription>
                        {scope
                            ? `This permanently removes ${scope} from your history.`
                            : 'This project has no tracked time yet.'}
                        {shared && ' It also stops being shared with your team.'}
                        {' This can’t be undone.'}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                        Type{' '}
                        <span className="font-medium text-foreground">{name}</span>{' '}
                        to confirm.
                    </p>
                    <Input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') submit();
                        }}
                        placeholder={name}
                        disabled={busy}
                    />
                </div>
                <DialogFooter>
                    <Button
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={submit}
                        disabled={!canDelete}
                    >
                        {busy && (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        )}
                        {busy ? 'Deleting…' : 'Delete project'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// A project's tinted disc. Same deterministic color and tint recipe as the member
// avatars, but rounded-square rather than circular: people are round, projects
// are not, so the two never read as the same kind of thing.
function ProjectDisc({ name }: { name: string }) {
    const color = projectColor(name);
    const initial = name.trim()[0]?.toUpperCase() || '?';
    return (
        <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-[11px] text-[13px] font-semibold"
            style={{
                backgroundColor: `color-mix(in oklab, ${color} 20%, transparent)`,
                color,
            }}
        >
            {initial}
        </span>
    );
}
