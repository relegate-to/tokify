import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    Check,
    ChevronDown,
    Clock,
    Cloud,
    Download,
    FolderKanban,
    Hourglass,
    ListChecks,
    Loader2,
    LogOut,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    Settings as SettingsIcon,
    ShieldCheck,
    Square,
    Timer,
    Trash2,
    User,
    X,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import {
    AddActivity,
    AuthSignIn,
    AuthSignOut,
    AuthSignUp,
    AuthStatus,
    Export,
    GetRunning,
    ListRecent,
    ListToday,
    Projects,
    RemoveActivity,
    Start,
    StartAt,
    Stop,
    SyncNow,
    SyncSetEnabled,
    SyncStatus,
    TeamsConnect,
    TeamsDisconnect,
    TeamsGetStatus,
    TeamsSetEnabled,
    TeamsSetTrackedProjects,
    UpdateActivity,
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { models, neonauth, neonsync, teams } from '../wailsjs/go/models';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Calendar } from '@/components/ui/calendar';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Activity = models.Activity;
type View = 'now' | 'history' | 'settings' | 'account';

const SHOW_ACCOUNT_KEY = 'toki.showAccount';
const ACTIVITY_VIEW_KEY = 'toki.activityView';
const SHOW_SCROLLBARS_KEY = 'toki.showScrollbars';
const THEME_KEY = 'toki.theme';

type ActivityView = 'all' | 'today' | 'none';
const ACTIVITY_VIEW_VALUES: ActivityView[] = ['all', 'today', 'none'];

type Theme = 'auto' | 'light' | 'dark';
const THEME_VALUES: Theme[] = ['auto', 'light', 'dark'];

function readActivityView(): ActivityView {
    try {
        const v = localStorage.getItem(ACTIVITY_VIEW_KEY);
        if (v && (ACTIVITY_VIEW_VALUES as string[]).includes(v)) {
            return v as ActivityView;
        }
    } catch {
        // ignore
    }
    return 'all';
}

function readTheme(): Theme {
    try {
        const v = localStorage.getItem(THEME_KEY);
        if (v && (THEME_VALUES as string[]).includes(v)) {
            return v as Theme;
        }
    } catch {
        // ignore
    }
    return 'auto';
}

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
    const [showAccount, setShowAccount] = useState<boolean>(() => {
        try {
            return localStorage.getItem(SHOW_ACCOUNT_KEY) === '1';
        } catch {
            return false;
        }
    });
    const [showScrollbars, setShowScrollbars] = useState<boolean>(() => {
        try {
            return localStorage.getItem(SHOW_SCROLLBARS_KEY) === '1';
        } catch {
            return false;
        }
    });
    const [activityView, setActivityView] = useState<ActivityView>(() =>
        readActivityView(),
    );
    const [theme, setTheme] = useState<Theme>(() => readTheme());
    const [teamsStatus, setTeamsStatus] = useState<teams.Status | null>(null);
    const [, setTick] = useState(0);

    const refreshTeams = () => {
        TeamsGetStatus()
            .then((s) => setTeamsStatus(s as teams.Status))
            .catch(() => setTeamsStatus(null));
    };

    useEffect(() => {
        try {
            localStorage.setItem(SHOW_ACCOUNT_KEY, showAccount ? '1' : '0');
        } catch {
            // ignore
        }
    }, [showAccount]);

    useEffect(() => {
        try {
            localStorage.setItem(SHOW_SCROLLBARS_KEY, showScrollbars ? '1' : '0');
        } catch {
            // ignore
        }
        document.documentElement.classList.toggle(
            'show-scrollbars',
            showScrollbars,
        );
    }, [showScrollbars]);

    useEffect(() => {
        try {
            localStorage.setItem(ACTIVITY_VIEW_KEY, activityView);
        } catch {
            // ignore
        }
    }, [activityView]);

    useEffect(() => {
        refreshTeams();
        const off = EventsOn('teams:error', (msg: string) => {
            toast.error(`Teams: ${msg}`);
        });
        return () => {
            try {
                off();
            } catch {
                // ignore
            }
        };
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(THEME_KEY, theme);
        } catch {
            // ignore
        }
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const apply = () => {
            const dark = theme === 'dark' || (theme === 'auto' && mql.matches);
            document.documentElement.classList.toggle('dark', dark);
        };
        apply();
        if (theme !== 'auto') return;
        mql.addEventListener('change', apply);
        return () => mql.removeEventListener('change', apply);
    }, [theme]);

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
    const handleStartAt = (description: string, project: string, startISO: string) =>
        StartAt(description, project, startISO)
            .then(refresh)
            .catch((e) => toast.error(String(e)));
    const handleStop = () =>
        Stop().then(refresh).catch((e) => toast.error(String(e)));
    const handleResume = (orig: Activity) => {
        setView('now');
        Start(orig.description ?? '', orig.project ?? '')
            .then(refresh)
            .catch((e) => toast.error(String(e)));
    };
    const handleAddPast = (
        description: string,
        project: string,
        startISO: string,
        endISO: string,
    ) =>
        AddActivity(description, project, startISO, endISO)
            .then(refresh)
            .catch((e) => toast.error(String(e)));
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
            <Masthead
                view={view}
                onView={setView}
                showAccount={showAccount}
                projects={projects}
            />
            <main className="flex-1 overflow-y-auto">
                <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-8 pb-12 pt-6">
                    {view === 'now' && (
                        <NowView
                            running={running}
                            today={today}
                            recent={recent}
                            projects={projects}
                            removingKeys={removingKeys}
                            activityView={activityView}
                            onStart={handleStart}
                            onStartAt={handleStartAt}
                            onStop={handleStop}
                            onUpdate={handleUpdate}
                            onRemove={handleRemove}
                            onResume={handleResume}
                            onAddPast={handleAddPast}
                        />
                    )}
                    {view === 'history' && (
                        <HistoryView
                            activities={recent}
                            projects={projects}
                            removingKeys={removingKeys}
                            onUpdate={handleUpdate}
                            onRemove={handleRemove}
                            onResume={handleResume}
                            onAddPast={handleAddPast}
                        />
                    )}
                    {view === 'settings' && (
                        <SettingsView
                            showAccount={showAccount}
                            onShowAccountChange={setShowAccount}
                            activityView={activityView}
                            onActivityViewChange={setActivityView}
                            showScrollbars={showScrollbars}
                            onShowScrollbarsChange={setShowScrollbars}
                            theme={theme}
                            onThemeChange={setTheme}
                            projects={projects}
                            teamsStatus={teamsStatus}
                            onTeamsRefresh={refreshTeams}
                            onBack={() => setView('now')}
                        />
                    )}
                    {view === 'account' && (
                        <AccountView
                            running={running}
                            recent={recent}
                            projects={projects}
                            onBack={() => setView('now')}
                        />
                    )}
                </div>
            </main>
            <Toaster position="bottom-right" richColors closeButton />
        </div>
    );
}

/* ── Masthead ──────────────────────────────────────────────────────────── */

const MASTHEAD_INTRO_SHOW_MS = 2000;
const MASTHEAD_INTRO_HIDE_MS = 4000;

function Masthead({
    view,
    onView,
    showAccount,
    projects,
}: {
    view: View;
    onView: (v: View) => void;
    showAccount: boolean;
    projects: string[];
}) {
    const date = new Date()
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
    const tabsValue = view === 'now' || view === 'history' ? view : '';
    const [introToki, setIntroToki] = useState(false);
    const [hover, setHover] = useState(false);
    const [open, setOpen] = useState(false);
    const [openedAsToki, setOpenedAsToki] = useState(false);
    const [nudgeKey, setNudgeKey] = useState(0);

    useEffect(() => {
        const showId = window.setTimeout(
            () => setIntroToki(true),
            MASTHEAD_INTRO_SHOW_MS,
        );
        const hideId = window.setTimeout(
            () => setIntroToki(false),
            MASTHEAD_INTRO_HIDE_MS,
        );
        return () => {
            window.clearTimeout(showId);
            window.clearTimeout(hideId);
        };
    }, []);

    const showToki = introToki || hover || (open && openedAsToki);
    const [exportOpen, setExportOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const handleOpenChange = (next: boolean) => {
        if (next) {
            const tokiNow = introToki || hover;
            setOpenedAsToki(tokiNow);
            if (tokiNow) setNudgeKey((k) => k + 1);
        } else {
            setOpenedAsToki(false);
        }
        setOpen(next);
    };

    // Radix dismisses the menu on a bubble-phase document listener, which a
    // child calling stopPropagation (e.g. a text input) can swallow — leaving
    // the menu open and the label stuck on "Toki". A capture-phase listener
    // runs before any child handler, so an outside press always closes it.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (triggerRef.current?.contains(target)) return;
            if (contentRef.current?.contains(target)) return;
            handleOpenChange(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () =>
            document.removeEventListener('pointerdown', onPointerDown, true);
    }, [open]);

    return (
        <>
        <header
            className="flex shrink-0 items-center justify-between border-b bg-background/80 pb-2 pl-28 pr-4 pt-3 backdrop-blur"
            style={dragStyle}
        >
            <div className="flex items-center gap-4" style={noDragStyle}>
                <Tabs value={tabsValue} onValueChange={(v) => onView(v as View)}>
                    <TabsList>
                        <TabsTrigger value="now">Now</TabsTrigger>
                        <TabsTrigger value="history">History</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>
            <div style={noDragStyle}>
                <DropdownMenu open={open} onOpenChange={handleOpenChange}>
                    <DropdownMenuTrigger asChild>
                        <button
                            ref={triggerRef}
                            type="button"
                            onMouseEnter={() => setHover(true)}
                            onMouseLeave={() => setHover(false)}
                            className="relative grid select-none overflow-hidden rounded-md px-2 py-1 outline-none transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-muted"
                        >
                            <span className="invisible col-start-1 row-start-1 px-1 text-xs font-medium uppercase tracking-[0.2em]">
                                Toki
                            </span>
                            <span className="invisible col-start-1 row-start-1 px-1 text-xs tabular-nums">
                                {date}
                            </span>
                            <span
                                aria-hidden={!showToki}
                                className={cn(
                                    'absolute inset-0 flex items-center justify-center pl-[0.2em] text-xs font-medium uppercase tracking-[0.2em] transition-[translate,opacity] duration-300 ease-out',
                                    showToki
                                        ? 'translate-x-0 opacity-100'
                                        : '-translate-x-full opacity-0',
                                )}
                            >
                                <span
                                    key={nudgeKey}
                                    className={cn(
                                        'inline-block',
                                        nudgeKey > 0 &&
                                            'animate-[toki-nudge_240ms_ease-out]',
                                    )}
                                >
                                    Toki
                                </span>
                            </span>
                            <span
                                aria-hidden={showToki}
                                className={cn(
                                    'absolute inset-0 flex items-center justify-center text-xs tabular-nums text-muted-foreground transition-[translate,opacity] duration-300 ease-out',
                                    showToki
                                        ? 'translate-x-full opacity-0'
                                        : 'translate-x-0 opacity-100',
                                )}
                            >
                                {date}
                            </span>
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent ref={contentRef}>
                        <DropdownMenuItem onSelect={() => onView('settings')}>
                            <SettingsIcon className="size-4 opacity-70" />
                            Settings
                        </DropdownMenuItem>
                        {showAccount && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onSelect={() => onView('account')}
                                >
                                    <User className="size-4 opacity-70" />
                                    Account
                                </DropdownMenuItem>
                            </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setExportOpen(true)}>
                            <Download className="size-4 opacity-70" />
                            Export…
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>
        <ExportDialog
            open={exportOpen}
            onOpenChange={setExportOpen}
            projects={projects}
        />
        </>
    );
}

/* ── Now ──────────────────────────────────────────────────────────────── */

function NowView({
    running,
    today,
    recent,
    projects,
    removingKeys,
    activityView,
    onStart,
    onStartAt,
    onStop,
    onUpdate,
    onRemove,
    onResume,
    onAddPast,
}: {
    running: Activity | null;
    today: Activity[];
    recent: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    activityView: ActivityView;
    onStart: (description: string, project: string) => void;
    onStartAt: (description: string, project: string, startISO: string) => void;
    onStop: () => void;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume: (orig: Activity) => void;
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
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

    const lastProject = useMemo(
        () => recent.find((a) => a.project)?.project ?? '',
        [recent],
    );

    const hasContentBelow =
        activityView !== 'none' &&
        (visibleToday.length > 0 ||
            (activityView === 'all' && earlierGroups.length > 0));
    const prominent = !hasContentBelow;
    // Only show the "nothing tracked yet" illustration when the user is seeing
    // the full activity view and has genuinely never recorded anything — not
    // when they've explicitly hidden earlier days via the 'today' setting.
    const isFullyEmpty =
        !running &&
        activityView === 'all' &&
        visibleToday.length === 0 &&
        earlierGroups.length === 0 &&
        recent.length === 0;

    return (
        <div className="flex flex-1 flex-col gap-8">
            {running ? (
                <NowRunning
                    activity={running}
                    onStop={onStop}
                    prominent={prominent}
                />
            ) : (
                <Starter
                    projects={projects}
                    lastProject={lastProject}
                    onStart={onStart}
                    onStartAt={onStartAt}
                />
            )}

            {activityView !== 'none' && !isFullyEmpty && (
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
                                    onResume={onResume}
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
            )}

            {isFullyEmpty && (
                <Empty className="flex-none border-none p-0 animate-in fade-in-0 duration-500">
                    <EmptyHeader>
                        <EmptyMedia className="flex size-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                            <Hourglass className="size-5" />
                        </EmptyMedia>
                        <EmptyTitle>Nothing tracked yet</EmptyTitle>
                        <EmptyDescription>
                            Type what you're working on above and press Enter to
                            start the clock.
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            )}

            {activityView === 'all' && earlierGroups.length > 0 && (
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
                                onResume={onResume}
                            />
                        ))}
                    </div>
                </section>
            )}

            {activityView !== 'none' && (
                <AddPastButton projects={projects} onAddPast={onAddPast} />
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
    prominent = false,
}: {
    activity: Activity;
    onStop: () => void;
    prominent?: boolean;
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
                'relative overflow-hidden rounded-xl border bg-card shadow-sm transition-[padding] duration-300 ease-out',
                prominent ? 'px-8 py-16' : 'p-6',
                stopping
                    ? 'animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards'
                    : 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-6',
            )}
            style={{
                animationDuration: stopping ? `${STOP_ANIM_MS}ms` : '520ms',
                animationTimingFunction: stopping ? EASE_OUT : EASE_THUNK,
            }}
        >
            {prominent ? (
                <div className="flex flex-col items-center gap-6 text-center">
                    {activity.project && (
                        <Badge variant="secondary">{activity.project}</Badge>
                    )}
                    <p className="max-w-md truncate text-xl font-medium leading-snug">
                        {activity.description || 'No description'}
                    </p>
                    <div
                        className="font-mono text-6xl leading-none tabular-nums"
                        aria-live="polite"
                    >
                        {formatDuration(ms)}
                    </div>
                    <span className="text-xs text-muted-foreground">
                        since {formatClock(since)}
                    </span>
                    <Button
                        onClick={handleStop}
                        variant="destructive"
                        size="sm"
                        disabled={stopping}
                        className="mt-2 transition-transform active:scale-95"
                    >
                        <Square data-icon="inline-start" /> Stop
                    </Button>
                </div>
            ) : (
                <>
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
                </>
            )}
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
    lastProject,
    onStart,
    onStartAt,
}: {
    projects: string[];
    lastProject: string;
    onStart: (description: string, project: string) => void;
    onStartAt: (description: string, project: string, startISO: string) => void;
}) {
    const [text, setText] = useState('');
    const [project, setProject] = useState(lastProject);
    const [startAt, setStartAt] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const startAtRef = useRef<HTMLInputElement>(null);
    const startAtOpen = startAt !== null;
    // Track the default we last seeded so we can follow updates to
    // `lastProject` only while the user hasn't taken over the field.
    const seededRef = useRef(lastProject);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        setProject((current) =>
            current === seededRef.current ? lastProject : current,
        );
        seededRef.current = lastProject;
    }, [lastProject]);

    useEffect(() => {
        if (startAtOpen) startAtRef.current?.focus();
    }, [startAtOpen]);

    const canStart = text.trim().length > 0;

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        if (startAt !== null && startAt.trim() !== '') {
            const iso = buildClockISO(new Date(), startAt);
            if (iso === null) {
                toast.error('Start time must be HH:MM');
                return;
            }
            if (new Date(iso).getTime() > Date.now()) {
                toast.error('Start time must be in the past');
                return;
            }
            onStartAt(trimmed, project.trim(), iso);
        } else {
            onStart(trimmed, project.trim());
        }
        setText('');
        setStartAt(null);
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
                        className="placeholder:select-none"
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
            <div className="flex h-6 items-center">
                {startAt === null ? (
                    <button
                        type="button"
                        onClick={() => setStartAt(formatClock(new Date()))}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <Clock className="size-3" />
                        Started earlier…
                    </button>
                ) : (
                    <div className="flex items-center gap-2 animate-in fade-in-0 slide-in-from-left-1 duration-200">
                        <Clock className="size-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                            started at
                        </span>
                        <Input
                            ref={startAtRef}
                            value={startAt}
                            onChange={(e) => setStartAt(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submit();
                                if (e.key === 'Escape') setStartAt(null);
                            }}
                            placeholder="HH:MM"
                            className="h-6 w-16 px-1.5 text-center font-mono text-xs tabular-nums"
                        />
                        <button
                            type="button"
                            onClick={() => setStartAt(null)}
                            className="text-muted-foreground transition-colors hover:text-foreground"
                            title="Clear"
                        >
                            <X className="size-3" />
                        </button>
                    </div>
                )}
            </div>
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
    onResume,
    readOnly = false,
}: {
    activity: Activity;
    projects: string[];
    isRemoving?: boolean;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume?: (orig: Activity) => void;
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
                        <>
                            {onResume && (
                                <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => onResume(activity)}
                                    className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                                    title="Resume — start a new activity with these details"
                                >
                                    <RotateCcw />
                                </Button>
                            )}
                            <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={remove}
                                className="text-destructive opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                                title="Remove"
                            >
                                <Trash2 />
                            </Button>
                        </>
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
    onResume,
}: {
    day: Date;
    activities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume?: (orig: Activity) => void;
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
                            onResume={onResume}
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
    onResume,
    onAddPast,
}: {
    activities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume: (orig: Activity) => void;
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
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
                    className="placeholder:select-none"
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
                            onResume={onResume}
                        />
                    ))}
                </div>
            )}

            <AddPastButton projects={projects} onAddPast={onAddPast} />
        </div>
    );
}

/* ── Add past activity ────────────────────────────────────────────────── */

function AddPastButton({
    projects,
    onAddPast,
}: {
    projects: string[];
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Plus className="size-3.5" />
                Add past activity
            </button>
            <AddPastDialog
                open={open}
                onOpenChange={setOpen}
                projects={projects}
                onAddPast={onAddPast}
            />
        </>
    );
}

function AddPastDialog({
    open,
    onOpenChange,
    projects,
    onAddPast,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    projects: string[];
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
}) {
    const [description, setDescription] = useState('');
    const [project, setProject] = useState('');
    const [date, setDate] = useState<Date>(() => startOfDay(new Date()));
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [startStr, setStartStr] = useState('09:00');
    const [endStr, setEndStr] = useState('10:00');

    useEffect(() => {
        if (!open) return;
        setDescription('');
        setProject('');
        setDate(startOfDay(new Date()));
        setStartStr('09:00');
        setEndStr('10:00');
    }, [open]);

    const submit = () => {
        const trimmed = description.trim();
        if (!trimmed) {
            toast.error('Description cannot be empty');
            return;
        }
        const startISO = buildClockISO(date, startStr);
        if (startISO === null) {
            toast.error('Start must be HH:MM');
            return;
        }
        const endISO = buildClockISO(date, endStr);
        if (endISO === null) {
            toast.error('End must be HH:MM');
            return;
        }
        if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
            toast.error('End must be after start');
            return;
        }
        onAddPast(trimmed, project.trim(), startISO, endISO);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add past activity</DialogTitle>
                    <DialogDescription>
                        Record something you tracked offline. The activity is
                        saved as completed.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Description
                        </label>
                        <Input
                            autoFocus
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submit();
                            }}
                            placeholder="What were you working on?"
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Project
                        </label>
                        <ProjectField
                            value={project}
                            onChange={setProject}
                            suggestions={projects}
                            onSubmit={submit}
                            placeholder="project (optional)"
                        />
                    </div>
                    <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-muted-foreground">
                                Date
                            </label>
                            <Popover
                                open={datePickerOpen}
                                onOpenChange={setDatePickerOpen}
                            >
                                <PopoverTrigger
                                    type="button"
                                    className="inline-flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm font-normal transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                                >
                                    {format(date, 'EEE, d MMM yyyy')}
                                    <ChevronDown className="size-4 opacity-60" />
                                </PopoverTrigger>
                                <PopoverContent
                                    className="z-[60] w-auto overflow-hidden p-0"
                                    align="start"
                                >
                                    <Calendar
                                        mode="single"
                                        selected={date}
                                        captionLayout="dropdown"
                                        onSelect={(d) => {
                                            if (!d) return;
                                            setDate(startOfDay(d));
                                            setDatePickerOpen(false);
                                        }}
                                    />
                                </PopoverContent>
                            </Popover>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-muted-foreground">
                                Start
                            </label>
                            <Input
                                value={startStr}
                                onChange={(e) => setStartStr(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') submit();
                                }}
                                placeholder="HH:MM"
                                className="h-8 w-20 px-2 text-center font-mono tabular-nums"
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-muted-foreground">
                                End
                            </label>
                            <Input
                                value={endStr}
                                onChange={(e) => setEndStr(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') submit();
                                }}
                                placeholder="HH:MM"
                                className="h-8 w-20 px-2 text-center font-mono tabular-nums"
                            />
                        </div>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit}>Add</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ── Export ───────────────────────────────────────────────────────────── */

type ExportFormat = 'txt' | 'csv' | 'json';
type ExportRange = 'all' | 'today' | 'yesterday' | 'custom';

const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
    { value: 'txt', label: 'Text' },
    { value: 'csv', label: 'CSV' },
    { value: 'json', label: 'JSON' },
];

const EXPORT_RANGES: { value: ExportRange; label: string }[] = [
    { value: 'all', label: 'All time' },
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'custom', label: 'Range' },
];

function toDateISO(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function resolveExportRange(
    range: ExportRange,
    fromDate: Date,
    toDate: Date,
): { from: string; to: string } {
    if (range === 'all') return { from: '', to: '' };
    if (range === 'today') {
        const t = toDateISO(new Date());
        return { from: t, to: t };
    }
    if (range === 'yesterday') {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        const iso = toDateISO(y);
        return { from: iso, to: iso };
    }
    return { from: toDateISO(fromDate), to: toDateISO(toDate) };
}

function ExportDialog({
    open,
    onOpenChange,
    projects,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    projects: string[];
}) {
    const [format, setFormat] = useState<ExportFormat>('txt');
    const [range, setRange] = useState<ExportRange>('all');
    const [fromDate, setFromDate] = useState<Date>(() => startOfDay(new Date()));
    const [toDate, setToDate] = useState<Date>(() => startOfDay(new Date()));
    const [fromOpen, setFromOpen] = useState(false);
    const [toOpen, setToOpen] = useState(false);
    const [project, setProject] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setFormat('txt');
        setRange('all');
        setFromDate(startOfDay(new Date()));
        setToDate(startOfDay(new Date()));
        setProject('');
        setSaving(false);
    }, [open]);

    const submit = () => {
        if (range === 'custom' && fromDate.getTime() > toDate.getTime()) {
            toast.error('From must not be after To');
            return;
        }
        const { from, to } = resolveExportRange(range, fromDate, toDate);
        setSaving(true);
        Export(format, from, to, project.trim())
            .then((path) => {
                if (path) {
                    toast.success('Exported', { description: path });
                    onOpenChange(false);
                }
            })
            .catch((e) => toast.error(String(e)))
            .finally(() => setSaving(false));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Export activities</DialogTitle>
                    <DialogDescription>
                        Filter what's saved. You'll pick the destination next.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Format
                        </label>
                        <SegmentedRow
                            value={format}
                            options={EXPORT_FORMATS}
                            onChange={setFormat}
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Date range
                        </label>
                        <SegmentedRow
                            value={range}
                            options={EXPORT_RANGES}
                            onChange={setRange}
                        />
                        {range === 'custom' && (
                            <div className="mt-1 grid grid-cols-2 gap-2">
                                <DatePickerField
                                    label="From"
                                    value={fromDate}
                                    open={fromOpen}
                                    onOpenChange={setFromOpen}
                                    onSelect={(d) => {
                                        setFromDate(startOfDay(d));
                                        setFromOpen(false);
                                    }}
                                />
                                <DatePickerField
                                    label="To"
                                    value={toDate}
                                    open={toOpen}
                                    onOpenChange={setToOpen}
                                    onSelect={(d) => {
                                        setToDate(startOfDay(d));
                                        setToOpen(false);
                                    }}
                                />
                            </div>
                        )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Project
                        </label>
                        <ProjectField
                            value={project}
                            onChange={setProject}
                            suggestions={projects}
                            onSubmit={submit}
                            placeholder="all projects"
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={saving}>
                        {saving ? 'Saving…' : 'Save…'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SegmentedRow<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div
            role="radiogroup"
            className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
        >
            {options.map((opt) => {
                const active = value === opt.value;
                return (
                    <button
                        key={opt.value}
                        role="radio"
                        aria-checked={active}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            'flex-1 rounded px-3 py-1 text-xs transition-colors',
                            active
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

function DatePickerField({
    label,
    value,
    open,
    onOpenChange,
    onSelect,
}: {
    label: string;
    value: Date;
    open: boolean;
    onOpenChange: (v: boolean) => void;
    onSelect: (d: Date) => void;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">{label}</label>
            <Popover open={open} onOpenChange={onOpenChange}>
                <PopoverTrigger
                    type="button"
                    className="inline-flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm font-normal transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                >
                    {format(value, 'd MMM yyyy')}
                    <ChevronDown className="size-4 opacity-60" />
                </PopoverTrigger>
                <PopoverContent
                    className="z-[60] w-auto overflow-hidden p-0"
                    align="start"
                >
                    <Calendar
                        mode="single"
                        selected={value}
                        captionLayout="dropdown"
                        onSelect={(d) => {
                            if (!d) return;
                            onSelect(d);
                        }}
                    />
                </PopoverContent>
            </Popover>
        </div>
    );
}

/* ── Account ──────────────────────────────────────────────────────────── */

// Wails rejects a binding promise with the Go error's message as a plain
// string; normalize the other shapes so the form never shows "[object Object]".
function authErrorText(err: unknown): string {
    if (typeof err === 'string' && err.trim()) return err;
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong. Try again.';
}

function AccountView({
    running,
    recent,
    projects,
    onBack,
}: {
    running: Activity | null;
    recent: Activity[];
    projects: string[];
    onBack: () => void;
}) {
    const [status, setStatus] = useState<neonauth.Status | null>(null);
    const [loading, setLoading] = useState(true);
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        AuthStatus()
            .then((s) => {
                if (!cancelled) setStatus(s);
            })
            .catch(() => {
                if (!cancelled) setStatus(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const submitAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting) return;
        setError('');
        setSubmitting(true);
        try {
            const next =
                mode === 'signin'
                    ? await AuthSignIn(email.trim(), password)
                    : await AuthSignUp(email.trim(), password, name.trim());
            setStatus(next);
            setPassword('');
        } catch (err) {
            setError(authErrorText(err));
        } finally {
            setSubmitting(false);
        }
    };

    const signOut = async () => {
        if (submitting) return;
        setError('');
        setSubmitting(true);
        try {
            await AuthSignOut();
            setStatus(await AuthStatus());
            setPassword('');
        } catch (err) {
            setError(authErrorText(err));
        } finally {
            setSubmitting(false);
        }
    };

    const stats = useMemo(() => {
        const all: Activity[] = running ? [running, ...recent] : recent;
        let totalMs = 0;
        let longestMs = 0;
        const projectSet = new Set<string>();
        const dayKeys = new Set<string>();
        let firstStart: number | null = null;
        for (const a of all) {
            const start = new Date(a.start_time as any).getTime();
            const end = a.end_time
                ? new Date(a.end_time as any).getTime()
                : Date.now();
            const dur = Math.max(0, end - start);
            totalMs += dur;
            if (dur > longestMs) longestMs = dur;
            if (a.project) projectSet.add(a.project);
            const d = new Date(start);
            dayKeys.add(
                `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
            );
            if (firstStart === null || start < firstStart) firstStart = start;
        }
        const days = dayKeys.size;
        return {
            totalMs,
            activityCount: all.length,
            projectCount: projectSet.size || projects.length,
            days,
            longestMs,
            avgPerDayMs: days > 0 ? Math.round(totalMs / days) : 0,
            firstStart,
        };
    }, [running, recent, projects]);

    const signedInName = (status?.name ?? '').trim();
    const signedInEmail = (status?.email ?? '').trim();
    const initials = useMemo(() => {
        const source = signedInName || signedInEmail;
        if (!source) return 'YOU';
        const parts = source
            .replace(/@.*$/, '')
            .split(/[\s._-]+/)
            .filter(Boolean);
        if (parts.length === 0) return source.slice(0, 2).toUpperCase();
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }, [signedInName, signedInEmail]);

    const accountDescription = !status?.configured
        ? 'Accounts are optional. Your time is always saved on this Mac.'
        : status.signed_in
          ? "You're signed in."
          : mode === 'signin'
            ? 'Sign in to your Toki account.'
            : 'Create a Toki account.';

    return (
        <div className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300">
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onBack}
                    title="Back"
                >
                    <ArrowLeft />
                </Button>
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Account
                </h2>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Account</CardTitle>
                    <CardDescription>{accountDescription}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    {loading ? (
                        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            Checking your account
                        </div>
                    ) : !status?.configured ? (
                        <div className="flex flex-col gap-1.5 py-1 text-sm text-muted-foreground">
                            <span>No account service connected yet.</span>
                            <span className="text-xs">
                                Set a Neon Auth URL to sign in.
                            </span>
                        </div>
                    ) : status.signed_in ? (
                        <div className="flex items-center gap-4">
                            <div
                                aria-hidden
                                className="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium tracking-wide text-foreground/80"
                            >
                                {initials}
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm font-medium">
                                    {signedInName || 'Signed in'}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                    {signedInEmail || 'No email'}
                                </span>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={signOut}
                                disabled={submitting}
                            >
                                {submitting ? (
                                    <Loader2
                                        data-icon="inline-start"
                                        className="animate-spin"
                                    />
                                ) : (
                                    <LogOut data-icon="inline-start" />
                                )}
                                Sign out
                            </Button>
                        </div>
                    ) : (
                        <>
                            <Tabs
                                value={mode}
                                onValueChange={(v) => {
                                    setMode(v as 'signin' | 'signup');
                                    setError('');
                                }}
                            >
                                <TabsList className="w-full">
                                    <TabsTrigger
                                        value="signin"
                                        className="flex-1"
                                    >
                                        Sign in
                                    </TabsTrigger>
                                    <TabsTrigger
                                        value="signup"
                                        className="flex-1"
                                    >
                                        Create account
                                    </TabsTrigger>
                                </TabsList>
                            </Tabs>
                            <form
                                key={mode}
                                onSubmit={submitAuth}
                                className="flex flex-col gap-3 animate-in fade-in-0 slide-in-from-top-1 duration-200"
                            >
                                {mode === 'signup' && (
                                    <div className="flex flex-col gap-1.5">
                                        <label
                                            htmlFor="auth-name"
                                            className="text-xs text-muted-foreground"
                                        >
                                            Name
                                        </label>
                                        <Input
                                            id="auth-name"
                                            value={name}
                                            onChange={(e) =>
                                                setName(e.target.value)
                                            }
                                            placeholder="Your name"
                                            autoComplete="name"
                                            spellCheck={false}
                                        />
                                    </div>
                                )}
                                <div className="flex flex-col gap-1.5">
                                    <label
                                        htmlFor="auth-email"
                                        className="text-xs text-muted-foreground"
                                    >
                                        Email
                                    </label>
                                    <Input
                                        id="auth-email"
                                        type="email"
                                        value={email}
                                        onChange={(e) =>
                                            setEmail(e.target.value)
                                        }
                                        placeholder="you@example.com"
                                        autoComplete="email"
                                        spellCheck={false}
                                        required
                                    />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <label
                                        htmlFor="auth-password"
                                        className="text-xs text-muted-foreground"
                                    >
                                        Password
                                    </label>
                                    <Input
                                        id="auth-password"
                                        type="password"
                                        value={password}
                                        onChange={(e) =>
                                            setPassword(e.target.value)
                                        }
                                        placeholder={
                                            mode === 'signin'
                                                ? 'Your password'
                                                : 'At least 8 characters'
                                        }
                                        autoComplete={
                                            mode === 'signin'
                                                ? 'current-password'
                                                : 'new-password'
                                        }
                                        required
                                    />
                                </div>
                                {error && (
                                    <p className="text-xs text-destructive">
                                        {error}
                                    </p>
                                )}
                                <Button
                                    type="submit"
                                    size="sm"
                                    className="mt-1"
                                    disabled={submitting}
                                >
                                    {submitting && (
                                        <Loader2
                                            data-icon="inline-start"
                                            className="animate-spin"
                                        />
                                    )}
                                    {mode === 'signin'
                                        ? 'Sign in'
                                        : 'Create account'}
                                </Button>
                            </form>
                        </>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Overview</CardTitle>
                    <CardDescription>
                        A snapshot of your tracked time so far.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <StatBlock
                            icon={<Timer className="size-3.5" />}
                            label="Total time"
                            value={formatTotal(stats.totalMs)}
                        />
                        <StatBlock
                            icon={<ListChecks className="size-3.5" />}
                            label="Activities"
                            value={stats.activityCount.toString()}
                        />
                        <StatBlock
                            icon={<FolderKanban className="size-3.5" />}
                            label="Projects"
                            value={stats.projectCount.toString()}
                        />
                        <StatBlock
                            icon={<Clock className="size-3.5" />}
                            label="Active days"
                            value={stats.days.toString()}
                        />
                    </div>
                    {(stats.longestMs > 0 || stats.firstStart !== null) && (
                        <>
                            <Separator className="my-4" />
                            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                                {stats.longestMs > 0 && (
                                    <div className="flex items-center justify-between gap-3">
                                        <dt className="text-muted-foreground">
                                            Longest session
                                        </dt>
                                        <dd className="font-mono tabular-nums">
                                            {formatTotal(stats.longestMs)}
                                        </dd>
                                    </div>
                                )}
                                {stats.days > 0 && (
                                    <div className="flex items-center justify-between gap-3">
                                        <dt className="text-muted-foreground">
                                            Avg per active day
                                        </dt>
                                        <dd className="font-mono tabular-nums">
                                            {formatTotal(stats.avgPerDayMs)}
                                        </dd>
                                    </div>
                                )}
                                {stats.firstStart !== null && (
                                    <div className="flex items-center justify-between gap-3 sm:col-span-2">
                                        <dt className="text-muted-foreground">
                                            Tracking since
                                        </dt>
                                        <dd className="tabular-nums">
                                            {new Date(
                                                stats.firstStart,
                                            ).toLocaleDateString(undefined, {
                                                day: '2-digit',
                                                month: 'short',
                                                year: 'numeric',
                                            })}
                                        </dd>
                                    </div>
                                )}
                            </dl>
                        </>
                    )}
                </CardContent>
            </Card>

            <SyncCard signedIn={!!status?.signed_in} />
        </div>
    );
}

function SyncCard({ signedIn }: { signedIn: boolean }) {
    const [status, setStatus] = useState<neonsync.SyncStatus | null>(null);
    const [toggling, setToggling] = useState(false);
    const [syncing, setSyncing] = useState(false);

    useEffect(() => {
        if (!signedIn) {
            setStatus(null);
            return;
        }
        let cancelled = false;
        SyncStatus()
            .then((s) => {
                if (!cancelled) setStatus(s);
            })
            .catch(() => {
                if (!cancelled) setStatus(null);
            });
        return () => {
            cancelled = true;
        };
    }, [signedIn]);

    // Background auto-sync runs on a timer in Go; refresh the card when it fires
    // so "Last synced" stays current without reopening the panel.
    useEffect(() => {
        if (!signedIn) return;
        return EventsOn('sync:updated', (s: neonsync.SyncStatus) => setStatus(s));
    }, [signedIn]);

    const toggleEnabled = (v: boolean) => {
        if (toggling) return;
        setToggling(true);
        SyncSetEnabled(v)
            .then(setStatus)
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setToggling(false));
    };

    const runSync = () => {
        if (syncing) return;
        setSyncing(true);
        const t = toast.loading('Syncing…');
        SyncNow()
            .then((s) => {
                setStatus(s);
                toast.success('Synced', {
                    id: t,
                    description: `${s.entry_count} ${
                        s.entry_count === 1 ? 'entry' : 'entries'
                    } encrypted`,
                });
            })
            .catch((e) => toast.error(authErrorText(e), { id: t }))
            .finally(() => setSyncing(false));
    };

    const configured = !!status?.configured;
    const enabled = !!status?.enabled;
    const lastSyncLabel = status?.last_sync
        ? format(new Date(status.last_sync), "d MMM yyyy 'at' HH:mm")
        : 'Never';

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Cloud className="size-4 opacity-70" />
                    Sync
                </CardTitle>
                <CardDescription className="flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5 shrink-0 opacity-70" />
                    End-to-end encrypted. Only you can read your history.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {!signedIn ? (
                    <p className="py-1 text-sm text-muted-foreground">
                        Sign in above to sync your activities across devices.
                    </p>
                ) : !configured ? (
                    <p className="py-1 text-sm text-muted-foreground">
                        Set a Neon Data API URL to turn on encrypted sync.
                    </p>
                ) : (
                    <>
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex min-w-0 flex-col">
                                <span className="text-sm">
                                    Sync across devices
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    Your local log stays the source of truth.
                                </span>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={enabled}
                                disabled={toggling}
                                onClick={() => toggleEnabled(!enabled)}
                                className={cn(
                                    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                                    enabled ? 'bg-foreground' : 'bg-muted',
                                )}
                            >
                                <span
                                    className={cn(
                                        'inline-block size-4 rounded-full bg-background shadow transition-transform',
                                        enabled
                                            ? 'translate-x-[1.125rem]'
                                            : 'translate-x-0.5',
                                    )}
                                />
                            </button>
                        </div>

                        {enabled && (
                            <div className="flex flex-col gap-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                                <Separator />
                                <div className="flex items-center justify-between gap-3 text-sm">
                                    <span className="text-muted-foreground">
                                        Last synced
                                    </span>
                                    <span className="tabular-nums">
                                        {lastSyncLabel}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between gap-3 text-sm">
                                    <span className="text-muted-foreground">
                                        Entries in the cloud
                                    </span>
                                    <span className="font-mono tabular-nums">
                                        {status?.entry_count ?? 0}
                                    </span>
                                </div>
                                {!status?.unlocked && (
                                    <p className="text-xs text-muted-foreground">
                                        Sign in again to unlock your encryption
                                        key on this device.
                                    </p>
                                )}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="self-start"
                                    onClick={runSync}
                                    disabled={syncing || !status?.unlocked}
                                >
                                    {syncing ? (
                                        <Loader2
                                            data-icon="inline-start"
                                            className="animate-spin"
                                        />
                                    ) : (
                                        <RefreshCw data-icon="inline-start" />
                                    )}
                                    Sync now
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function StatBlock({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
}) {
    return (
        <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {icon}
                {label}
            </span>
            <span className="font-mono text-lg leading-tight tabular-nums">
                {value}
            </span>
        </div>
    );
}

/* ── Settings ─────────────────────────────────────────────────────────── */

function SettingsView({
    showAccount,
    onShowAccountChange,
    activityView,
    onActivityViewChange,
    showScrollbars,
    onShowScrollbarsChange,
    theme,
    onThemeChange,
    projects,
    teamsStatus,
    onTeamsRefresh,
    onBack,
}: {
    showAccount: boolean;
    onShowAccountChange: (v: boolean) => void;
    activityView: ActivityView;
    onActivityViewChange: (v: ActivityView) => void;
    showScrollbars: boolean;
    onShowScrollbarsChange: (v: boolean) => void;
    theme: Theme;
    onThemeChange: (v: Theme) => void;
    projects: string[];
    teamsStatus: teams.Status | null;
    onTeamsRefresh: () => void;
    onBack: () => void;
}) {
    const teamsEnabled = !!teamsStatus?.enabled;
    const teamsConnected = !!teamsStatus?.connected;
    const teamsProjects = teamsStatus?.tracked_projects ?? [];

    const handleTeamsEnabled = (v: boolean) => {
        TeamsSetEnabled(v)
            .then(onTeamsRefresh)
            .catch((e) => toast.error(String(e)));
    };
    const handleTeamsProjects = (next: string[]) => {
        TeamsSetTrackedProjects(next)
            .then(onTeamsRefresh)
            .catch((e) => toast.error(String(e)));
    };
    const handleTeamsDisconnect = () => {
        TeamsDisconnect()
            .then(() => {
                toast.success('Disconnected from Teams');
                onTeamsRefresh();
            })
            .catch((e) => toast.error(String(e)));
    };
    return (
        <div
            className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300"
        >
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onBack}
                    title="Back"
                >
                    <ArrowLeft />
                </Button>
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Settings
                </h2>
            </div>
            <div className="flex flex-col divide-y rounded-xl border bg-card shadow-sm">
                <SettingSegmentedRow
                    title="Theme"
                    description="Auto follows your system appearance."
                    value={theme}
                    onChange={onThemeChange}
                    options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                    ]}
                />
                <SettingSegmentedRow
                    title="Show activity"
                    description="Controls what appears under the running card on the Now page."
                    value={activityView}
                    onChange={onActivityViewChange}
                    options={[
                        { value: 'all', label: 'All' },
                        { value: 'today', label: 'Today only' },
                        { value: 'none', label: 'Hidden' },
                    ]}
                />
                <SettingRow
                    title="Show scrollbars"
                    description="Hidden by default for a cleaner look. Scrolling still works."
                    value={showScrollbars}
                    onChange={onShowScrollbarsChange}
                />
                <SettingRow
                    title="Show account in menu"
                    description="Reveals the Account item in the date menu."
                    value={showAccount}
                    onChange={onShowAccountChange}
                />
            </div>

            <div className="flex flex-col gap-3">
                <h3 className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Integrations
                </h3>
                <div className="flex flex-col divide-y rounded-xl border bg-card shadow-sm">
                    <SettingRow
                        title="Microsoft Teams status"
                        description="Sets your Teams status message to the description of the activity you're currently tracking."
                        value={teamsEnabled}
                        onChange={handleTeamsEnabled}
                    />
                    {teamsEnabled && (
                        <TeamsConnectionRow
                            connected={teamsConnected}
                            status={teamsStatus}
                            onConnected={onTeamsRefresh}
                            onDisconnect={handleTeamsDisconnect}
                        />
                    )}
                    {teamsEnabled && teamsConnected && (
                        <TeamsProjectsPicker
                            projects={projects}
                            selected={teamsProjects}
                            onChange={handleTeamsProjects}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function TeamsConnectionRow({
    connected,
    status,
    onConnected,
    onDisconnect,
}: {
    connected: boolean;
    status: teams.Status | null;
    onConnected: () => void;
    onDisconnect: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const handleConnect = () => {
        setBusy(true);
        const t = toast.loading('Opening Microsoft sign-in…');
        TeamsConnect()
            .then(() => {
                toast.success('Connected to Teams', { id: t });
                onConnected();
            })
            .catch((e) => toast.error(String(e), { id: t }))
            .finally(() => setBusy(false));
    };
    if (connected) {
        return (
            <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-col">
                    <span className="text-sm">Connected</span>
                    {status?.user_upn && (
                        <span className="truncate text-xs text-muted-foreground">
                            Signed in as {status.user_upn}
                        </span>
                    )}
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onDisconnect}
                >
                    Disconnect
                </Button>
            </div>
        );
    }
    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">Not connected</span>
                <span className="text-xs text-muted-foreground">
                    A Microsoft sign-in window will open. When prompted with
                    “Stay signed in?”, choose <strong>Yes</strong> — sign-in
                    won't complete otherwise. Tokens stay in your macOS
                    Keychain.
                </span>
            </div>
            <Button size="sm" onClick={handleConnect} disabled={busy}>
                {busy ? 'Signing in…' : 'Connect'}
            </Button>
        </div>
    );
}

function TeamsProjectsPicker({
    projects,
    selected,
    onChange,
}: {
    projects: string[];
    selected: string[];
    onChange: (v: string[]) => void;
}) {
    const selectedSet = useMemo(() => new Set(selected), [selected]);
    const toggle = (p: string) => {
        const next = new Set(selectedSet);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        onChange(Array.from(next));
    };
    return (
        <div className="flex flex-col gap-2 px-4 py-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm">Apply to projects</span>
                <span className="text-xs text-muted-foreground">
                    {selected.length === 0
                        ? 'None selected'
                        : `${selected.length} selected`}
                </span>
            </div>
            <p className="text-xs text-muted-foreground">
                Only activities under the selected projects will update your
                Teams status. Other activities are left private.
            </p>
            {projects.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                    No projects yet — start an activity with a project to add it
                    here.
                </p>
            ) : (
                <div className="flex flex-wrap gap-1">
                    {projects.map((p) => {
                        const active = selectedSet.has(p);
                        return (
                            <button
                                key={p}
                                type="button"
                                onClick={() => toggle(p)}
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

function SettingSegmentedRow<T extends string>({
    title,
    description,
    value,
    onChange,
    options,
}: {
    title: string;
    description?: string;
    value: T;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
}) {
    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">{title}</span>
                {description && (
                    <span className="text-xs text-muted-foreground">
                        {description}
                    </span>
                )}
            </div>
            <div className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5">
                {options.map((opt) => {
                    const active = opt.value === value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => onChange(opt.value)}
                            className={cn(
                                'rounded px-2.5 py-1 text-xs transition-colors',
                                active
                                    ? 'bg-background text-foreground shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {opt.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function SettingRow({
    title,
    description,
    value,
    onChange,
}: {
    title: string;
    description?: string;
    value: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">{title}</span>
                {description && (
                    <span className="text-xs text-muted-foreground">
                        {description}
                    </span>
                )}
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={value}
                onClick={() => onChange(!value)}
                className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                    value ? 'bg-foreground' : 'bg-muted',
                )}
            >
                <span
                    className={cn(
                        'inline-block size-4 rounded-full bg-background shadow transition-transform',
                        value ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
                    )}
                />
            </button>
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
