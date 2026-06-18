import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Check,
    Play,
    Search,
    Square,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    GetRunning,
    ListRecent,
    ListToday,
    Projects,
    RemoveActivity,
    Start,
    Stop,
    UpdateActivity,
} from '../wailsjs/go/main/App';
import { models } from '../wailsjs/go/models';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Activity = models.Activity;
type View = 'now' | 'history';

const REFRESH_MS = 30_000;
const TICK_MS = 1_000;
const EARLIER_DAYS = 7;
const HISTORY_LIMIT = 500;
const REMOVE_ANIM_MS = 240;

const dragStyle = {
    // Wails draggable hint and webkit equivalent
    ['--wails-draggable' as any]: 'drag',
    WebkitAppRegion: 'drag',
} as React.CSSProperties;

const noDragStyle = {
    ['--wails-draggable' as any]: 'no-drag',
    WebkitAppRegion: 'no-drag',
} as React.CSSProperties;

function App() {
    const [view, setView] = useState<View>('now');
    const [running, setRunning] = useState<Activity | null>(null);
    const [today, setToday] = useState<Activity[]>([]);
    const [recent, setRecent] = useState<Activity[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set());
    const [, setTick] = useState(0);

    const refresh = () => {
        Promise.all([
            GetRunning(),
            ListToday(),
            ListRecent(HISTORY_LIMIT),
            Projects(),
        ])
            .then(([r, t, all, p]) => {
                setRunning((r as Activity) ?? null);
                setToday((t as Activity[]) ?? []);
                setRecent((all as Activity[]) ?? []);
                setProjects(p ?? []);
            })
            .catch((e) => toast.error(String(e)));
    };

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        if (!running) return;
        const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
        return () => clearInterval(id);
    }, [running]);

    const handleStart = (description: string, project: string) =>
        Start(description, project).then(refresh).catch((e) => toast.error(String(e)));
    const handleStop = () =>
        Stop().then(refresh).catch((e) => toast.error(String(e)));
    const handleUpdate = (
        orig: Activity,
        description: string,
        project: string,
        startISO: string,
        endISO: string,
    ) =>
        UpdateActivity(orig, description, project, startISO, endISO)
            .then(refresh)
            .catch((e) => toast.error(String(e)));
    const handleRemove = (orig: Activity) => {
        const key = String(orig.start_time);
        setRemovingKeys((s) => {
            if (s.has(key)) return s;
            const n = new Set(s);
            n.add(key);
            return n;
        });
        window.setTimeout(() => {
            RemoveActivity(orig)
                .then(refresh)
                .catch((e) => toast.error(String(e)))
                .finally(() => {
                    setRemovingKeys((s) => {
                        if (!s.has(key)) return s;
                        const n = new Set(s);
                        n.delete(key);
                        return n;
                    });
                });
        }, REMOVE_ANIM_MS);
    };

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
            <Masthead view={view} onView={setView} />
            <main className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl px-8 pb-12 pt-6">
                    {view === 'now' ? (
                        <NowView
                            running={running}
                            today={today}
                            recent={recent}
                            projects={projects}
                            removingKeys={removingKeys}
                            onStart={handleStart}
                            onStop={handleStop}
                            onUpdate={handleUpdate}
                            onRemove={handleRemove}
                        />
                    ) : (
                        <HistoryView
                            activities={recent}
                            projects={projects}
                            removingKeys={removingKeys}
                            onUpdate={handleUpdate}
                            onRemove={handleRemove}
                        />
                    )}
                </div>
            </main>
            <Toaster position="bottom-right" richColors closeButton />
        </div>
    );
}

/* ── Masthead ──────────────────────────────────────────────────────────── */

function Masthead({ view, onView }: { view: View; onView: (v: View) => void }) {
    const date = new Date()
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
    return (
        <header
            className="flex shrink-0 items-center justify-between border-b bg-background/80 pb-2 pl-28 pr-4 pt-3 backdrop-blur"
            style={dragStyle}
        >
            <div className="flex items-center gap-4" style={noDragStyle}>
                <span className="text-sm font-semibold tracking-tight">
                    Toki
                </span>
                <Tabs value={view} onValueChange={(v) => onView(v as View)}>
                    <TabsList>
                        <TabsTrigger value="now">Now</TabsTrigger>
                        <TabsTrigger value="history">History</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>
            <span
                className="text-xs tabular-nums text-muted-foreground"
                style={noDragStyle}
            >
                {date}
            </span>
        </header>
    );
}

/* ── Now ──────────────────────────────────────────────────────────────── */

function NowView({
    running,
    today,
    recent,
    projects,
    removingKeys,
    onStart,
    onStop,
    onUpdate,
    onRemove,
}: {
    running: Activity | null;
    today: Activity[];
    recent: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onStart: (description: string, project: string) => void;
    onStop: () => void;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
}) {
    const visibleToday = useMemo(
        () => today.filter((a) => !removingKeys.has(String(a.start_time))),
        [today, removingKeys],
    );
    const todayTotal = useMemo(
        () => totalDuration(visibleToday),
        [visibleToday, running],
    );

    const earlier = useMemo(() => {
        const cutoff =
            startOfDay(new Date()).getTime() - EARLIER_DAYS * 24 * 60 * 60 * 1000;
        const todayStart = startOfDay(new Date()).getTime();
        return recent.filter((a) => {
            const t = new Date(a.start_time as any).getTime();
            return t < todayStart && t >= cutoff;
        });
    }, [recent]);

    const earlierGroups = useMemo(
        () => groupByLocalDate(earlier, false),
        [earlier],
    );

    return (
        <div className="flex flex-col gap-8">
            {running ? (
                <NowRunning activity={running} onStop={onStop} />
            ) : (
                <Starter projects={projects} onStart={onStart} />
            )}

            <section aria-label="Today">
                <SectionHeader title="Today" right={
                    <span className="text-xs tabular-nums text-muted-foreground">
                        {formatTotal(todayTotal)}
                    </span>
                } />
                <div className="relative min-h-11">
                    {today.length > 0 && (
                        <ul className="flex flex-col">
                            {today.map((a) => (
                                <ActivityRow
                                    key={String(a.start_time)}
                                    activity={a}
                                    projects={projects}
                                    isRemoving={removingKeys.has(String(a.start_time))}
                                    onUpdate={onUpdate}
                                    onRemove={onRemove}
                                    readOnly={!a.end_time}
                                />
                            ))}
                        </ul>
                    )}
                    <p
                        className={cn(
                            'pointer-events-none absolute inset-x-0 top-0 flex h-11 items-center px-3 text-sm text-muted-foreground transition-opacity duration-300 ease-out',
                            visibleToday.length === 0
                                ? 'opacity-100'
                                : 'opacity-0',
                        )}
                        aria-hidden={visibleToday.length !== 0}
                    >
                        Nothing tracked today.
                    </p>
                </div>
            </section>

            {earlierGroups.length > 0 && (
                <section aria-label="Earlier">
                    <SectionHeader title="Earlier" />
                    <div className="flex flex-col gap-6">
                        {earlierGroups.map((g) => (
                            <DayGroup
                                key={g.dateKey}
                                day={g.date}
                                activities={g.items}
                                projects={projects}
                                removingKeys={removingKeys}
                                onUpdate={onUpdate}
                                onRemove={onRemove}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function SectionHeader({
    title,
    right,
}: {
    title: string;
    right?: React.ReactNode;
}) {
    return (
        <div className="mb-2 flex items-baseline justify-between px-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {title}
            </h2>
            {right}
        </div>
    );
}

/* ── Running card ─────────────────────────────────────────────────────── */

// Spring-flavoured easings (back-out for "thunk" entry, ease-in for exit).
const EASE_THUNK = 'cubic-bezier(0.34, 1.45, 0.55, 1)';
const EASE_OUT = 'cubic-bezier(0.4, 0, 1, 1)';
const STOP_ANIM_MS = 380;

function NowRunning({
    activity,
    onStop,
}: {
    activity: Activity;
    onStop: () => void;
}) {
    const since = new Date(activity.start_time as any);
    const ms = Date.now() - since.getTime();
    const seconds = Math.floor(ms / 1000) % 60;
    const minutePct = (seconds / 60) * 100;
    const [stopping, setStopping] = useState(false);

    const handleStop = () => {
        if (stopping) return;
        setStopping(true);
        window.setTimeout(onStop, STOP_ANIM_MS);
    };

    return (
        <section
            aria-label="Currently running"
            className={cn(
                'relative overflow-hidden rounded-xl border bg-card p-6 shadow-sm',
                stopping
                    ? 'animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards'
                    : 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-6',
            )}
            style={{
                animationDuration: stopping ? `${STOP_ANIM_MS}ms` : '520ms',
                animationTimingFunction: stopping ? EASE_OUT : EASE_THUNK,
            }}
        >
            <div className="flex items-baseline justify-between gap-4">
                <p className="min-w-0 flex-1 truncate text-xl font-medium leading-snug">
                    {activity.description || 'No description'}
                </p>
                <div
                    className="font-mono text-2xl leading-none tabular-nums"
                    aria-live="polite"
                >
                    {formatDuration(ms)}
                </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    {activity.project && (
                        <Badge variant="secondary">{activity.project}</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                        since {formatClock(since)}
                    </span>
                </div>
                <Button
                    onClick={handleStop}
                    variant="destructive"
                    size="sm"
                    disabled={stopping}
                    className="transition-transform active:scale-95"
                >
                    <Square data-icon="inline-start" /> Stop
                </Button>
            </div>
            <div
                className={cn(
                    'absolute bottom-0 left-0 h-0.5 bg-foreground transition-[width] ease-linear',
                    stopping ? 'duration-300' : 'duration-1000',
                )}
                style={{ width: stopping ? '100%' : `${minutePct}%` }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={60}
                aria-valuenow={seconds}
                aria-label="Progress through current minute"
            />
        </section>
    );
}

/* ── Starter ──────────────────────────────────────────────────────────── */

function Starter({
    projects,
    onStart,
}: {
    projects: string[];
    onStart: (description: string, project: string) => void;
}) {
    const [text, setText] = useState('');
    const [project, setProject] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const canStart = text.trim().length > 0;

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        onStart(trimmed, project.trim());
        setText('');
    };

    return (
        <section
            aria-label="Start a new activity"
            className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-400"
            style={{ animationTimingFunction: EASE_THUNK }}
        >
            <div className="flex items-center gap-2">
                <InputGroup className="flex-1">
                    <InputGroupAddon align="inline-start">
                        <Play className="opacity-50" />
                    </InputGroupAddon>
                    <InputGroupInput
                        ref={inputRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') submit();
                        }}
                        placeholder="What are you working on?"
                        autoComplete="off"
                        spellCheck={false}
                    />
                </InputGroup>
                <Button
                    onClick={submit}
                    disabled={!canStart}
                    size="sm"
                    className="transition-transform active:scale-95"
                >
                    Start
                </Button>
            </div>
            <ProjectField
                value={project}
                onChange={setProject}
                suggestions={projects}
                onSubmit={submit}
            />
        </section>
    );
}

/* ── Project Field — type freely, click a chip to set ─────────────────── */

function ProjectField({
    value,
    onChange,
    suggestions,
    onSubmit,
    placeholder = 'project (optional)',
    size = 'sm',
}: {
    value: string;
    onChange: (v: string) => void;
    suggestions: string[];
    onSubmit?: () => void;
    placeholder?: string;
    size?: 'sm' | 'xs';
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && onSubmit) {
                        e.preventDefault();
                        onSubmit();
                    }
                }}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                className={cn(size === 'xs' ? 'h-7' : 'h-8')}
            />
            {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {suggestions.map((p) => {
                        const active = value === p;
                        return (
                            <button
                                key={p}
                                type="button"
                                onClick={() => onChange(active ? '' : p)}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors',
                                    active
                                        ? 'border-foreground bg-foreground text-background'
                                        : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                                )}
                            >
                                {active && <Check className="size-3" />}
                                {p}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/* ── Activity row (fixed height, swaps in inputs on edit) ─────────────── */

const ROW_HEIGHT = 'h-11';
const ROW_GRID =
    'grid grid-cols-[4rem_minmax(0,1fr)_5rem_auto] items-center gap-3 px-3';

function ActivityRow({
    activity,
    projects,
    isRemoving = false,
    onUpdate,
    onRemove,
    readOnly = false,
}: {
    activity: Activity;
    projects: string[];
    isRemoving?: boolean;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    readOnly?: boolean;
}) {
    const start = new Date(activity.start_time as any);
    const end = activity.end_time ? new Date(activity.end_time as any) : null;
    const ms = (end?.getTime() ?? Date.now()) - start.getTime();
    const isRunning = !end;

    const [editing, setEditing] = useState(false);
    const [desc, setDesc] = useState(activity.description ?? '');
    const [project, setProject] = useState(activity.project ?? '');
    const [startStr, setStartStr] = useState(formatClock(start));
    const [endStr, setEndStr] = useState(end ? formatClock(end) : '');
    const descRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) descRef.current?.focus();
    }, [editing]);

    useEffect(() => {
        setDesc(activity.description ?? '');
        setProject(activity.project ?? '');
        setStartStr(formatClock(start));
        setEndStr(end ? formatClock(end) : '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activity.description, activity.project, activity.start_time, activity.end_time]);

    const save = () => {
        const trimmed = desc.trim();
        if (!trimmed) {
            toast.error('Description cannot be empty');
            return;
        }
        const startISO = buildClockISO(start, startStr);
        if (startISO === null) {
            toast.error('Start must be HH:MM');
            return;
        }
        let endISO = '';
        if (end) {
            const built = buildClockISO(end, endStr);
            if (built === null) {
                toast.error('End must be HH:MM');
                return;
            }
            endISO = built;
        }
        onUpdate(activity, trimmed, project.trim(), startISO, endISO);
        setEditing(false);
    };

    const cancel = () => {
        setDesc(activity.description ?? '');
        setProject(activity.project ?? '');
        setStartStr(formatClock(start));
        setEndStr(end ? formatClock(end) : '');
        setEditing(false);
    };

    const remove = () => onRemove(activity);

    const enterEdit = () => {
        if (!readOnly) setEditing(true);
    };

    return (
        <li
            onDoubleClick={enterEdit}
            className={cn(
                'group/row relative overflow-hidden rounded-md border border-transparent',
                'transition-[height,opacity,transform,background-color,border-color] duration-200 ease-out',
                isRemoving ? 'h-0 -translate-x-2 opacity-0' : ROW_HEIGHT,
                ROW_GRID,
                editing ? 'border-border bg-muted/40' : 'hover:bg-muted/40',
                !readOnly && !editing && 'cursor-text',
                !isRemoving &&
                    'animate-in fade-in-0 slide-in-from-top-1 duration-300',
            )}
        >
            {editing ? (
                <Input
                    value={startStr}
                    onChange={(e) => setStartStr(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') save();
                        if (e.key === 'Escape') cancel();
                    }}
                    placeholder="HH:MM"
                    className="h-7 px-1.5 text-center font-mono text-xs tabular-nums"
                />
            ) : (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatClock(start)}
                </span>
            )}

            {editing ? (
                <div className="flex min-w-0 items-center gap-2">
                    <Input
                        value={project}
                        onChange={(e) => setProject(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') save();
                            if (e.key === 'Escape') cancel();
                        }}
                        placeholder="project"
                        list={`projects-${start.getTime()}`}
                        className="h-7 w-28 shrink-0"
                    />
                    <datalist id={`projects-${start.getTime()}`}>
                        {projects.map((p) => (
                            <option key={p} value={p} />
                        ))}
                    </datalist>
                    <Input
                        ref={descRef}
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') save();
                            if (e.key === 'Escape') cancel();
                        }}
                        placeholder="Description"
                        className="h-7 flex-1"
                    />
                </div>
            ) : (
                <div className="flex min-w-0 items-center gap-2">
                    {activity.project && (
                        <Badge
                            variant={isRunning ? 'default' : 'secondary'}
                            className="shrink-0"
                        >
                            {activity.project}
                        </Badge>
                    )}
                    <span
                        className={cn(
                            'truncate text-sm',
                            !activity.description && 'text-muted-foreground',
                        )}
                    >
                        {activity.description || 'No description'}
                    </span>
                </div>
            )}

            {editing && end ? (
                <Input
                    value={endStr}
                    onChange={(e) => setEndStr(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') save();
                        if (e.key === 'Escape') cancel();
                    }}
                    placeholder="HH:MM"
                    className="h-7 px-1.5 text-center font-mono text-xs tabular-nums"
                />
            ) : (
                <span
                    className={cn(
                        'text-right font-mono text-xs tabular-nums',
                        isRunning ? 'text-foreground' : 'text-muted-foreground',
                    )}
                >
                    {formatDuration(ms)}
                </span>
            )}

            <div className="flex items-center gap-1">
                {editing ? (
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={save}
                        title="Save (enter) — esc to cancel"
                    >
                        <Check />
                    </Button>
                ) : (
                    !readOnly && (
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={remove}
                            className="text-destructive opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                            title="Remove"
                        >
                            <Trash2 />
                        </Button>
                    )
                )}
            </div>
        </li>
    );
}

/* ── Day group ────────────────────────────────────────────────────────── */

function DayGroup({
    day,
    activities,
    projects,
    removingKeys,
    onUpdate,
    onRemove,
}: {
    day: Date;
    activities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
}) {
    const visible = activities.filter(
        (a) => !removingKeys.has(String(a.start_time)),
    );
    const totalMs = visible.reduce((sum, a) => {
        const startMs = new Date(a.start_time as any).getTime();
        const endMs = a.end_time
            ? new Date(a.end_time as any).getTime()
            : startMs;
        return sum + (endMs - startMs);
    }, 0);
    const allRemoving = activities.length > 0 && visible.length === 0;
    return (
        <div
            className="grid transition-[grid-template-rows,opacity] ease-out"
            style={{
                gridTemplateRows: allRemoving ? '0fr' : '1fr',
                opacity: allRemoving ? 0 : 1,
                transitionDuration: `${REMOVE_ANIM_MS}ms`,
            }}
        >
            <div
                className={cn(
                    'min-h-0 overflow-hidden',
                    !allRemoving &&
                        'animate-in fade-in-0 slide-in-from-top-1 duration-300',
                )}
            >
                <div className="mb-1 flex items-baseline justify-between px-3">
                    <h3 className="text-xs font-medium text-muted-foreground">
                        {dayLabel(day)}
                    </h3>
                    <span className="text-xs tabular-nums text-muted-foreground">
                        {formatTotal(totalMs)}
                    </span>
                </div>
                <ul className="flex flex-col">
                    {activities.map((a) => (
                        <ActivityRow
                            key={String(a.start_time)}
                            activity={a}
                            projects={projects}
                            isRemoving={removingKeys.has(String(a.start_time))}
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                        />
                    ))}
                </ul>
            </div>
        </div>
    );
}

/* ── History ──────────────────────────────────────────────────────────── */

function HistoryView({
    activities,
    projects,
    removingKeys,
    onUpdate,
    onRemove,
}: {
    activities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
}) {
    const [query, setQuery] = useState('');

    const finished = useMemo(
        () => activities.filter((a) => a.end_time),
        [activities],
    );
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return finished;
        return finished.filter(
            (a) =>
                (a.description ?? '').toLowerCase().includes(q) ||
                (a.project ?? '').toLowerCase().includes(q),
        );
    }, [finished, query]);

    const groups = useMemo(() => groupByLocalDate(filtered, true), [filtered]);

    return (
        <div className="flex flex-col gap-6">
            <InputGroup>
                <InputGroupAddon align="inline-start">
                    <Search className="opacity-50" />
                </InputGroupAddon>
                <InputGroupInput
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search description or project"
                    autoComplete="off"
                    spellCheck={false}
                />
                <InputGroupAddon align="inline-end">
                    <span className="text-xs text-muted-foreground">
                        {query
                            ? `${filtered.length} of ${finished.length}`
                            : `${finished.length} ${
                                  finished.length === 1 ? 'activity' : 'activities'
                              }`}
                    </span>
                </InputGroupAddon>
            </InputGroup>

            {groups.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyTitle>
                            {finished.length === 0
                                ? 'No finished activities yet'
                                : 'No matches'}
                        </EmptyTitle>
                        <EmptyDescription>
                            {finished.length === 0
                                ? 'Start tracking from the Now tab.'
                                : 'Try a different search.'}
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <div className="flex flex-col gap-6">
                    {groups.map((g) => (
                        <DayGroup
                            key={g.dateKey}
                            day={g.date}
                            activities={g.items}
                            projects={projects}
                            removingKeys={removingKeys}
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function startOfDay(d: Date) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function groupByLocalDate(
    activities: Activity[],
    includeToday: boolean,
): { dateKey: string; date: Date; items: Activity[] }[] {
    const todayStart = startOfDay(new Date()).getTime();
    const buckets = new Map<string, { date: Date; items: Activity[] }>();

    for (const a of activities) {
        const start = new Date(a.start_time as any);
        const dayStart = startOfDay(start);
        if (!includeToday && dayStart.getTime() >= todayStart) continue;
        const key = `${dayStart.getFullYear()}-${dayStart.getMonth()}-${dayStart.getDate()}`;
        const existing = buckets.get(key);
        if (existing) {
            existing.items.unshift(a);
        } else {
            buckets.set(key, { date: dayStart, items: [a] });
        }
    }

    return Array.from(buckets.entries())
        .map(([dateKey, value]) => ({ dateKey, ...value }))
        .sort((a, b) => b.date.getTime() - a.date.getTime());
}

function dayLabel(d: Date) {
    const today = startOfDay(new Date()).getTime();
    const diffDays = Math.round((today - d.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) {
        return d.toLocaleDateString(undefined, { weekday: 'long' });
    }
    return d.toLocaleDateString(undefined, {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
    });
}

function totalDuration(activities: Activity[]) {
    let ms = 0;
    for (const a of activities) {
        const end = a.end_time
            ? new Date(a.end_time as any).getTime()
            : Date.now();
        ms += end - new Date(a.start_time as any).getTime();
    }
    return ms;
}

function pad(n: number) {
    return n < 10 ? `0${n}` : String(n);
}
function formatClock(d: Date) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Parses "HH:MM" and combines it with the date portion of `base` to produce
// an RFC3339 ISO string in the local timezone. Returns null on invalid input.
function buildClockISO(base: Date, hhmm: string): string | null {
    const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(hhmm);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    const next = new Date(base);
    next.setHours(h, min, 0, 0);
    // Local ISO with offset, e.g. 2026-06-18T09:42:00+01:00 — Go time.Parse
    // RFC3339 accepts this.
    const tz = -next.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    const tzAbs = Math.abs(tz);
    const off = `${sign}${pad(Math.floor(tzAbs / 60))}:${pad(tzAbs % 60)}`;
    return (
        `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` +
        `T${pad(next.getHours())}:${pad(next.getMinutes())}:${pad(next.getSeconds())}` +
        off
    );
}
function formatDuration(ms: number) {
    const total = Math.max(0, Math.floor(ms / 60_000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${pad(h)}:${pad(m)}`;
}
function formatTotal(ms: number) {
    const total = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

export default App;
