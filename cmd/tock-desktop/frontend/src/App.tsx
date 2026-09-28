import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';
import type { Swiper as SwiperInstance } from 'swiper';
import { Mousewheel } from 'swiper/modules';
import { Swiper, SwiperSlide } from 'swiper/react';
import 'swiper/css';

import {
    AddActivity,
    AuthStatus,
    GetRunning,
    ListPastYear,
    ListProjects,
    ListRecent,
    ListToday,
    MenuBarMode,
    Projects,
    RemoveActivity,
    SetMenuBarMode,
    SharingListTeams,
    SharingProjectShares,
    SharingSharedEntries,
    Start,
    StartAt,
    Stop,
    ActivityHistoryState,
    RedoLastActivityChange,
    UndoLastActivityChange,
    UpdateActivity,
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { main, neonauth } from '../wailsjs/go/models';

import type { Activity, ActivityItem, ActivityView, Theme, UndoState, View } from '@/types';
import { EASE_FLIP, REMOVE_ANIM_MS, REMOVE_FLIP_MS } from '@/lib/motion';
import { captureFlip, playFlip, type FlipSnapshot } from '@/lib/flip';
import { setProjectColorOverrides } from '@/lib/colors';
import { cn } from '@/lib/utils';
import { CompactContext } from '@/lib/compact';
import {
    ProjectSharesContext,
    type ProjectSharesMap,
} from '@/lib/project-shares';
import { TeamsCacheContext } from '@/lib/teams-cache';
import { Toaster } from '@/components/ui/sonner';
import { Masthead } from '@/components/Masthead';
import { NowView } from '@/components/NowView';
import {
    SketchpadView,
    completeSketchpadTodo,
    readTodoRuns,
    writeTodoRuns,
    type TodoRun,
} from '@/components/SketchpadView';
import { FinishTodoDialog } from '@/components/FinishTodoDialog';
import { HistoryView } from '@/components/HistoryView';
import { SettingsView } from '@/components/SettingsView';
import { AccountView } from '@/components/AccountView';
import { SharingView } from '@/components/SharingView';
import { TeamsView } from '@/components/TeamsView';
import { ProjectsView } from '@/components/ProjectsView';
import { ReportsView } from '@/components/ReportsView';
import { ChartsView } from '@/components/ChartsView';
import { StatsView } from '@/components/StatsView';

const SHOW_ACCOUNT_KEY = 'tokify.showAccount';
const ACTIVITY_VIEW_KEY = 'tokify.activityView';
const SHOW_SCROLLBARS_KEY = 'tokify.showScrollbars';
const THEME_KEY = 'tokify.theme';
const DAILY_GOAL_KEY = 'tokify.dailyGoal';
const AUTO_COMPLETE_TODOS_KEY = 'tokify.autoCompleteTodos';
const DEFAULT_DAILY_GOAL = 360;
const DAILY_GOAL_VALUES = [240, 360, 480];
const ACTIVITY_VIEW_VALUES: ActivityView[] = ['all', 'today', 'none'];
const LOG_VIEWS: View[] = ['history', 'reports', 'charts', 'stats'];
const SWIPE_VIEWS: View[] = ['sketchpad', 'now', ...LOG_VIEWS];
// How long after a wheel, touch, or pointer event a slide change still counts
// as the user's swipe; trackpad momentum and scroll snapping settle within it.
const SWIPE_INPUT_MS = 1000;

const THEME_VALUES: Theme[] = ['auto', 'light', 'dark'];

// Menu bar mode hangs the window from the status item. The panel sits this far
// below the window's top edge, and the tail fills the strip above it.
const TAIL_HEIGHT = 10;
const TAIL_WIDTH = 24;

function MenuBarTail({ x }: { x: number }) {
    return (
        <svg
            aria-hidden
            width={TAIL_WIDTH}
            height={TAIL_HEIGHT}
            viewBox={`0 0 ${TAIL_WIDTH} ${TAIL_HEIGHT}`}
            className="pointer-events-none fixed top-0 z-50 overflow-visible"
            style={{ left: `clamp(16px, ${x - TAIL_WIDTH / 2}px, calc(100vw - ${TAIL_WIDTH + 16}px))` }}
        >
            <path
                d="M0 10 C5 10 8.5 1.25 12 1.25 C15.5 1.25 19 10 24 10"
                fill="var(--background)"
                stroke="var(--border)"
                strokeWidth="1"
            />
        </svg>
    );
}

function parseUndoState(value: string): UndoState {
    return JSON.parse(value) as UndoState;
}

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

function readDailyGoal(): number {
    try {
        const v = Number(localStorage.getItem(DAILY_GOAL_KEY));
        if (DAILY_GOAL_VALUES.includes(v)) return v;
    } catch {
        // ignore
    }
    return DEFAULT_DAILY_GOAL;
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
const HISTORY_LIMIT = 500;

// Shared entries come off the network, not from local actions, so they poll on
// their own attention-aware cadence rather than riding the local refresh: snappy
// while the window is focused, gentler when it's merely visible, and paused
// entirely when it's hidden to the menu bar. Nobody's watching a hidden window,
// and a held-open poll would only keep the machine (and Neon's compute) awake for
// nothing — the crossover where real-time push would pay for itself is well past
// the scale a menu-bar tracker reaches.
const SHARED_POLL_ACTIVE_MS = 10_000;
const SHARED_POLL_IDLE_MS = 30_000;

// Listing teams fans out per-team member/share/name queries, so the masthead's
// pending-invite check runs on a slow, coarse cadence of its own — invitations
// are rare, arriving-once events, not a live feed. It only runs while the window
// is visible and signed in, and wakes on focus for a prompt check when you return.
const INVITE_POLL_MS = 90_000;

// mapShared turns the backend's decrypted, author-verified shared activities into
// list rows tagged with their author. These are display-only: they render in the
// Activity view but are never written to the local log.
function mapShared(entries: main.SharedActivity[]): ActivityItem[] {
    return entries.map(
        (e) =>
            ({
                description: e.activity.description,
                project: e.activity.project,
                start_time: e.activity.start_time,
                end_time: e.activity.end_time,
                notes: e.activity.notes,
                tags: e.activity.tags,
                shared: {
                    authorId: e.author_id,
                    authorName: e.author_name,
                    authorImage: e.author_image,
                    teamName: e.team_name,
                },
            }) as ActivityItem,
    );
}

// Shared rows are rebuilt from scratch on every poll, so the array is a new
// identity even when the answer is identical. Feeding that straight into state
// re-ran the whole Log view — regrouping, the project filters and a full
// 365-cell contribution graph — every ten seconds, which lands as a stutter if
// it coincides with a row animating out. Only adopt rows that actually differ.
function sameShared(a: ActivityItem[], b: ActivityItem[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((x, i) => {
        const y = b[i];
        return (
            x.start_time === y.start_time &&
            x.end_time === y.end_time &&
            x.description === y.description &&
            x.project === y.project &&
            x.shared?.authorId === y.shared?.authorId &&
            x.shared?.teamName === y.shared?.teamName
        );
    });
}

function App() {
    const [view, setView] = useState<View>('now');
    const [sharingProject, setSharingProject] = useState<string | undefined>();
    const [running, setRunning] = useState<Activity | null>(null);
    const [runningLoaded, setRunningLoaded] = useState(false);
    const [finishingTodo, setFinishingTodo] = useState<TodoRun | null>(null);
    const [autoCompleteTodos, setAutoCompleteTodos] = useState<boolean>(() => {
        try {
            return localStorage.getItem(AUTO_COMPLETE_TODOS_KEY) === '1';
        } catch {
            return false;
        }
    });
    const [today, setToday] = useState<Activity[]>([]);
    const [pastYear, setPastYear] = useState<Activity[]>([]);
    const [recent, setRecent] = useState<Activity[]>([]);
    const [shared, setShared] = useState<ActivityItem[]>([]);
    const [pendingInvites, setPendingInvites] = useState<main.TeamView[]>([]);
    const [teams, setTeams] = useState<main.TeamView[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [projectShares, setProjectShares] = useState<ProjectSharesMap>({});
    const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set());
    const [undoState, setUndoState] = useState<UndoState>({
        can_undo: false,
        can_redo: false,
    });
    const [showAccount, setShowAccount] = useState<boolean>(() => {
        try {
            return localStorage.getItem(SHOW_ACCOUNT_KEY) !== '0';
        } catch {
            return true;
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
    const [dailyGoal, setDailyGoal] = useState<number>(() => readDailyGoal());
    const [theme, setTheme] = useState<Theme>(() => readTheme());
    const [menuBar, setMenuBar] = useState(false);
    const [tailX, setTailX] = useState<number | null>(null);
    const [authStatus, setAuthStatus] = useState<neonauth.Status | null>(null);
    // Activities deleted locally that a refresh already in flight may still be
    // carrying an answer for. Filtering them out of every refresh until the
    // delete has committed is what stops a removed row flickering back.
    const suppressedKeys = useRef<Set<string>>(new Set());
    const isSuppressed = (a: Activity | null) =>
        !!a && suppressedKeys.current.has(String(a.start_time));
    const withoutSuppressed = (list: Activity[]) =>
        suppressedKeys.current.size === 0
            ? list
            : list.filter((a) => !isSuppressed(a));

    // FLIP bookkeeping for removal: positions are captured just before the row
    // leaves the lists, and replayed in the layout phase of the commit that
    // drops it, before the browser has painted the new positions.
    const flipRoot = useRef<HTMLElement | null>(null);
    const flipFirst = useRef<FlipSnapshot | null>(null);
    const [flipToken, setFlipToken] = useState(0);

    useLayoutEffect(() => {
        const first = flipFirst.current;
        if (!first) return;
        flipFirst.current = null;
        playFlip(flipRoot.current, first, REMOVE_FLIP_MS, EASE_FLIP);
    }, [flipToken]);

    const viewRef = useRef<View>(view);
    const logSwiperRef = useRef<SwiperInstance | null>(null);
    const programmaticSlide = useRef(false);
    const programmaticTimer = useRef<number | null>(null);

    viewRef.current = view;

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
        try {
            localStorage.setItem(AUTO_COMPLETE_TODOS_KEY, autoCompleteTodos ? '1' : '0');
        } catch {
            // ignore
        }
    }, [autoCompleteTodos]);

    useEffect(() => {
        try {
            localStorage.setItem(DAILY_GOAL_KEY, String(dailyGoal));
        } catch {
            // ignore
        }
    }, [dailyGoal]);

    useEffect(() => {
        AuthStatus()
            .then((s) => setAuthStatus(s))
            .catch(() => setAuthStatus(null));
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

    // Stable identity: the row handlers close over it, and they in turn are what
    // let the memoised ActivityRow skip re-rendering the whole log.
    // isSuppressed/withoutSuppressed only read a ref, so they need no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const refresh = useCallback(() => {
        return Promise.all([
            GetRunning(),
            ListToday(),
            ListPastYear(),
            ListRecent(HISTORY_LIMIT),
            Projects(),
        ])
            .then(([r, t, year, all, p]) => {
                const run = (r as Activity) ?? null;
                setRunning(isSuppressed(run) ? null : run);
                setRunningLoaded(true);
                setToday(withoutSuppressed((t as Activity[]) ?? []));
                setPastYear(withoutSuppressed((year as Activity[]) ?? []));
                setRecent(withoutSuppressed((all as Activity[]) ?? []));
                setProjects(p ?? []);
            })
            .catch((e) => toast.error(String(e)));
    }, []);

    const refreshUndoState = useCallback(() => {
        return ActivityHistoryState()
            .then((status) => setUndoState(parseUndoState(status)))
            .catch(() => {
                // History is an enhancement; activity refreshes remain usable if
                // the backend has not finished starting yet.
            });
    }, []);

    useEffect(() => {
        refresh();
        refreshUndoState();
        const id = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(id);
    }, []);

    // Pinned project colors live in the registry. Load them into the module-level
    // override map so every projectColor caller picks them up, then re-fetch the
    // activity data so the memoized charts recompute against the new colors. This
    // also runs after a rename or color change on the Projects page (onChanged),
    // which is what refreshes the stats under a project's new name promptly.
    const loadColors = () => {
        ListProjects()
            .then((list) => {
                const map: Record<string, string> = {};
                for (const p of list ?? []) {
                    if (p.color) map[p.name] = p.color;
                }
                setProjectColorOverrides(map);
                refresh();
            })
            .catch(() => {
                // colors are cosmetic; a failure just keeps the derived defaults
            });
    };

    useEffect(() => {
        loadColors();
    }, []);

    // Poll shared entries independently of the local refresh. A sharing/network
    // error (or sync being off) is best-effort: it must never break local state,
    // and a transient failure keeps the last-good rows rather than flickering the
    // merged view empty. Cadence follows window attention, and the poll pauses
    // while hidden, waking with an immediate pull when the window returns.
    useEffect(() => {
        let timer: number | null = null;
        let cancelled = false;

        const pull = () => {
            SharingSharedEntries()
                .then((entries) => {
                    if (cancelled) return;
                    const next = mapShared(entries ?? []);
                    setShared((cur) => (sameShared(cur, next) ? cur : next));
                })
                .catch(() => {
                    // keep last-good shared rows
                });
        };

        const schedule = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (document.visibilityState === 'hidden') return;
            const delay = document.hasFocus()
                ? SHARED_POLL_ACTIVE_MS
                : SHARED_POLL_IDLE_MS;
            timer = window.setTimeout(() => {
                pull();
                schedule();
            }, delay);
        };

        const wake = () => {
            if (document.visibilityState !== 'hidden') pull();
            schedule();
        };

        // The backend serves its cache instantly and refreshes in the background;
        // when that refresh finds a change it pushes the fresh rows here, so the UI
        // updates without waiting for the next poll tick.
        const offUpdated = EventsOn('shared:updated', (entries: main.SharedActivity[]) => {
            if (cancelled) return;
            const next = mapShared(entries ?? []);
            setShared((cur) => (sameShared(cur, next) ? cur : next));
        });

        pull();
        schedule();
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        window.addEventListener('blur', schedule);
        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            offUpdated();
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('focus', wake);
            window.removeEventListener('blur', schedule);
        };
    }, []);

    // Drop one invitation from the badge the moment the user acts on it, instead
    // of re-listing every team (an expensive fan-out reserved for INVITE_POLL_MS).
    // The accept/decline already succeeded server-side; the poll reconciles anything
    // that arrived meanwhile.
    const dismissInvite = useCallback((teamID: string) => {
        setPendingInvites((cur) => cur.filter((t) => t.ID !== teamID));
    }, []);

    // Pending team invitations for the masthead badge. Gated on being signed in
    // (a signed-out session has no teams to list) and kept off the hot shared-entries
    // cadence because listing teams is expensive — see INVITE_POLL_MS.
    useEffect(() => {
        if (!authStatus?.signed_in) {
            setPendingInvites([]);
            setTeams([]);
            setProjectShares({});
            return;
        }
        let timer: number | null = null;
        let cancelled = false;

        const pull = () => {
            SharingListTeams()
                .then((list) => {
                    if (cancelled) return;
                    const all = list ?? [];
                    setTeams(all);
                    setPendingInvites(all.filter((t) => t.Pending));
                })
                .catch(() => {
                    // keep last-good invites
                });
            // The shared-with badge data rides the same slow, signed-in cadence:
            // team membership and share filters change rarely, so this need not sit
            // on the hot refresh loop. The slice is keyed by project for lookup.
            SharingProjectShares()
                .then((shares) => {
                    if (cancelled) return;
                    const map: ProjectSharesMap = {};
                    for (const s of shares ?? []) map[s.Project] = s;
                    setProjectShares(map);
                })
                .catch(() => {
                    // keep last-good badge data
                });
        };

        const schedule = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (document.visibilityState === 'hidden') return;
            timer = window.setTimeout(() => {
                pull();
                schedule();
            }, INVITE_POLL_MS);
        };

        const wake = () => {
            if (document.visibilityState !== 'hidden') pull();
            schedule();
        };

        pull();
        schedule();
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('focus', wake);
        };
    }, [authStatus?.signed_in]);

    const afterMutation = useCallback(
        () => Promise.all([refresh(), refreshUndoState()]),
        [refresh, refreshUndoState],
    );
    const handleUndo = useCallback(() => {
        UndoLastActivityChange()
            .then((status) => {
                setUndoState(parseUndoState(status));
                return refresh();
            })
            .then(() => toast.success('Change undone'))
            .catch((e) => toast.error(String(e)));
    }, [refresh]);
    const handleRedo = useCallback(() => {
        RedoLastActivityChange()
            .then((status) => {
                setUndoState(parseUndoState(status));
                return refresh();
            })
            .then(() => toast.success('Change redone'))
            .catch((e) => toast.error(String(e)));
    }, [refresh]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
            event.preventDefault();
            if (event.shiftKey) handleRedo();
            else handleUndo();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleRedo, handleUndo]);

    useEffect(() => {
        MenuBarMode()
            .then(setMenuBar)
            .catch(() => {});
        const offs = [
            EventsOn('menubar:mode', (on: boolean) => setMenuBar(on)),
            EventsOn('menubar:tail', (x: number) => setTailX(x)),
            // The tray starts and stops activities behind the page's back.
            EventsOn('activities:changed', () => afterMutation()),
            EventsOn('tray:navigate', (next: View) => setView(next)),
            EventsOn('tray:error', (message: string) => toast.error(message)),
        ];
        return () => offs.forEach((off) => off());
    }, [afterMutation]);

    useEffect(() => {
        document.documentElement.classList.toggle('menubar', menuBar);
    }, [menuBar]);

    const handleMenuBarChange = (on: boolean) => {
        SetMenuBarMode(on).catch((e) => toast.error(String(e)));
    };

    // An activity started from a to-do has finished once it's no longer the
    // running one, however it was stopped: here, from the tray, or elsewhere.
    useEffect(() => {
        if (!runningLoaded || finishingTodo) return;
        const current = running ? String(running.start_time) : null;
        const runs = readTodoRuns();
        const finished = runs.filter((run) => run.start !== current);
        if (finished.length === 0) return;
        if (!autoCompleteTodos) {
            setFinishingTodo(finished[0]);
            return;
        }
        writeTodoRuns(runs.filter((run) => run.start === current));
        const ticked = finished.filter((run) => completeSketchpadTodo(run.id));
        if (ticked.length === 1) toast.success(`Ticked off “${ticked[0].description}”`);
        else if (ticked.length > 1) toast.success(`Ticked off ${ticked.length} to-dos`);
    }, [running, runningLoaded, finishingTodo, autoCompleteTodos]);

    const answerFinishingTodo = (done: boolean, always: boolean) => {
        const todo = finishingTodo;
        if (!todo) return;
        writeTodoRuns(readTodoRuns().filter((run) => run.start !== todo.start));
        if (done) completeSketchpadTodo(todo.id);
        if (always) setAutoCompleteTodos(true);
        setFinishingTodo(null);
    };

    const handleStart = (description: string, project: string, notes: string) =>
        Start(description, project, notes).then(afterMutation).catch((e) => toast.error(String(e)));
    const handleStartAt = (description: string, project: string, notes: string, startISO: string) =>
        StartAt(description, project, notes, startISO)
            .then(afterMutation)
            .catch((e) => toast.error(String(e)));
    const handleStop = () =>
        Stop().then(afterMutation).catch((e) => toast.error(String(e)));
    const handleResume = useCallback(
        (orig: Activity) => {
            setView('now');
            Start(orig.description ?? '', orig.project ?? '', orig.notes ?? '')
                .then(afterMutation)
                .catch((e) => toast.error(String(e)));
        },
        [afterMutation],
    );
    const handleAddPast = (
        description: string,
        project: string,
        notes: string,
        startISO: string,
        endISO: string,
    ) =>
        AddActivity(description, project, notes, startISO, endISO)
            .then(afterMutation)
            .catch((e) => toast.error(String(e)));
    const handleUpdate = useCallback(
        (
            orig: Activity,
            description: string,
            project: string,
            notes: string,
            startISO: string,
            endISO: string,
        ) =>
            UpdateActivity(orig, description, project, notes, startISO, endISO)
                .then(afterMutation)
                .catch((e) => toast.error(String(e))),
        [afterMutation],
    );
    const handleRemove = useCallback(
        (orig: Activity) => {
            const key = String(orig.start_time);
            if (suppressedKeys.current.has(key)) return;

            const forget = () =>
                setRemovingKeys((s) => {
                    if (!s.has(key)) return s;
                    const n = new Set(s);
                    n.delete(key);
                    return n;
                });

            // Delete and animate at once. Waiting for the round trip before
            // starting the collapse is what made a delete lag before anything
            // moved, and clearing the row's state before the data caught up is
            // what then sprang it back to full height.
            suppressedKeys.current.add(key);
            setRemovingKeys((s) => new Set(s).add(key));
            writeTodoRuns(readTodoRuns().filter((run) => run.start !== key));

            const collapsed = new Promise<void>((resolve) =>
                window.setTimeout(resolve, REMOVE_ANIM_MS),
            );

            // A delete is a mutation whose shape we already know, so the new
            // state is the old lists minus one row — no refetch. Re-reading the
            // whole log to learn that meant waiting on five IPC calls and then
            // handing every view brand-new arrays, which recomputed the day
            // groups, the project filters and a 365-cell contribution graph a
            // beat after the row had already gone. The periodic refresh
            // reconciles anything else.
            Promise.all([RemoveActivity(orig), collapsed])
                .then(() => {
                    flipFirst.current = captureFlip(flipRoot.current);
                    const drop = (list: Activity[]) =>
                        list.filter((a) => String(a.start_time) !== key);
                    setToday(drop);
                    setRecent(drop);
                    setPastYear(drop);
                    setRunning((r) =>
                        r && String(r.start_time) === key ? null : r,
                    );
                    suppressedKeys.current.delete(key);
                    forget();
                    setFlipToken((t) => t + 1);
                    refreshUndoState();
                    toast.success('Activity deleted', {
                        action: { label: 'Undo', onClick: handleUndo },
                    });
                })
                .catch((e) => {
                    // The entry still exists, so lifting the suppression and
                    // refreshing puts the row back where it was.
                    suppressedKeys.current.delete(key);
                    forget();
                    toast.error(String(e));
                    refresh();
                });
        },
        [handleUndo, refresh, refreshUndoState],
    );

    const handleView = (next: View) => {
        if (next === 'sharing') setSharingProject(undefined);
        setView(next);
    };

    useEffect(() => {
        const swiper = logSwiperRef.current;
        const index = SWIPE_VIEWS.indexOf(view);
        if (!swiper || index === -1 || swiper.activeIndex === index) return;
        // A programmatic move across several slides scrolls through the
        // intermediate ones, and Swiper fires onSlideChange for each. Flag the
        // move so those intermediate slides don't feed back into setView —
        // otherwise the transient log-view values reopen the collapsed log
        // icons and re-enter this effect with a stale activeIndex, bouncing the
        // scroll back the other way.
        programmaticSlide.current = true;
        if (programmaticTimer.current !== null) {
            window.clearTimeout(programmaticTimer.current);
        }
        swiper.slideTo(index);
        programmaticTimer.current = window.setTimeout(() => {
            programmaticSlide.current = false;
            programmaticTimer.current = null;
        }, 360);
    }, [view]);

    useEffect(
        () => () => {
            if (programmaticTimer.current !== null) {
                window.clearTimeout(programmaticTimer.current);
            }
        },
        [],
    );

    // The view is the source of truth for the slider. Resizing the window
    // (entering or leaving menu bar mode, the popover reappearing) can reset the
    // slider's scroll before Swiper re-measures, which it reports as a move to
    // the first slide. Only a swipe the user actually made may change the view;
    // anything else snaps the slider back to the current view.
    const lastSwipeInput = useRef(0);
    const markSwipeInput = () => {
        lastSwipeInput.current = performance.now();
    };
    const resyncSlider = useCallback(() => {
        const swiper = logSwiperRef.current;
        const index = SWIPE_VIEWS.indexOf(viewRef.current);
        if (!swiper || swiper.destroyed || index === -1) return;
        swiper.update();
        if (swiper.activeIndex !== index) swiper.slideTo(index, 0);
    }, []);
    useEffect(() => {
        let timer: number | null = null;
        const settle = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(resyncSlider, 250);
        };
        window.addEventListener('resize', settle);
        document.addEventListener('visibilitychange', settle);
        return () => {
            window.removeEventListener('resize', settle);
            document.removeEventListener('visibilitychange', settle);
            if (timer !== null) window.clearTimeout(timer);
        };
    }, [resyncSlider]);

    const isSwipeView = SWIPE_VIEWS.includes(view);
    const pagePadding = menuBar ? 'px-5 pb-8 pt-[64px]' : 'px-8 pb-12 pt-[70px]';

    // Projects for filtering, autocomplete, and export come from the local log, but
    // a recipient's shared entries carry projects they don't track locally. Fold
    // those in (appended, so the local order stays familiar) wherever the merged
    // activity view is what the user is looking at. Sharing/Settings deliberately
    // stay on local projects — you can only share or expose your own.
    const mergedProjects = useMemo(() => {
        const seen = new Set(projects);
        const extra: string[] = [];
        for (const s of shared) {
            const p = s.project;
            if (p && !seen.has(p)) {
                seen.add(p);
                extra.push(p);
            }
        }
        return extra.length ? [...projects, ...extra] : projects;
    }, [projects, shared]);

    // The Reports/Charts/Stats summaries read the full local year. ListPastYear
    // already spans today, but a session stopped between refresh ticks can land
    // in `today` first, so fold in any today rows not yet in the year snapshot.
    const summaryActivities = useMemo<Activity[]>(() => {
        const seen = new Set(pastYear.map((a) => String(a.start_time)));
        const extra = today.filter(
            (a) => a.end_time && !seen.has(String(a.start_time)),
        );
        return extra.length ? [...pastYear, ...extra] : pastYear;
    }, [pastYear, today]);

    return (
        <ProjectSharesContext.Provider value={projectShares}>
        <TeamsCacheContext.Provider value={teams}>
        <CompactContext.Provider value={menuBar}>
        {menuBar && <MenuBarTail x={tailX ?? window.innerWidth / 2} />}
        <div
            className={cn(
                'flex flex-col overflow-y-hidden bg-background text-foreground',
                menuBar
                    ? 'relative overflow-hidden rounded-[14px] border'
                    : 'h-screen',
            )}
            style={
                menuBar
                    ? { marginTop: TAIL_HEIGHT - 1, height: `calc(100vh - ${TAIL_HEIGHT - 1}px)` }
                    : undefined
            }
        >
            <Masthead
                view={view}
                onView={handleView}
                running={running}
                showAccount={showAccount}
                account={authStatus}
                projects={mergedProjects}
                invites={pendingInvites}
                hasShared={shared.length > 0}
                undoState={undoState}
                onUndo={handleUndo}
                onRedo={handleRedo}
                menuBar={menuBar}
            />
            <main
                ref={flipRoot}
                className={`flex-1 overflow-x-visible overscroll-none ${isSwipeView ? 'overflow-hidden' : 'overflow-y-auto'}`}
            >
                <div className="flex h-full w-full flex-col">
                    {isSwipeView && (
                        <div
                            className="h-full overflow-visible"
                            onWheel={markSwipeInput}
                            onPointerDown={markSwipeInput}
                            onTouchStart={markSwipeInput}
                        >
                            <Swiper
                                className="tokify-log-swiper h-full w-full"
                                style={{ overflow: 'visible' }}
                                cssMode
                                slidesPerView={1}
                                slidesPerGroup={1}
                                spaceBetween={32}
                                speed={300}
                                modules={[Mousewheel]}
                                initialSlide={Math.max(0, SWIPE_VIEWS.indexOf(view))}
                                mousewheel={{
                                    forceToAxis: true,
                                    sensitivity: 2,
                                    thresholdTime: 250,
                                }}
                                onSwiper={(swiper) => {
                                    logSwiperRef.current = swiper;
                                }}
                                onSlideChange={(swiper) => {
                                    if (programmaticSlide.current) return;
                                    const next = SWIPE_VIEWS[swiper.activeIndex];
                                    if (!next || next === viewRef.current) return;
                                    if (performance.now() - lastSwipeInput.current > SWIPE_INPUT_MS) {
                                        requestAnimationFrame(resyncSlider);
                                        return;
                                    }
                                    setView(next);
                                }}
                        >
                            <SwiperSlide>
                                <div className={cn('h-full overflow-y-auto', pagePadding)}>
                                    <SketchpadView projects={mergedProjects} onStartTodo={(todo) =>
                                        Start(todo.description, todo.project, todo.notes)
                                            .then((activity) => {
                                                writeTodoRuns([
                                                    ...readTodoRuns(),
                                                    { start: String(activity.start_time), id: todo.id, description: todo.description },
                                                ]);
                                                return afterMutation();
                                            })
                                            .then(() => setView('now'))
                                            .catch((e) => toast.error(String(e)))
                                    } />
                                </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className={cn('h-full overflow-y-auto', pagePadding)}>
                                    <NowView
                                            running={running}
                                            today={today}
                                            recent={recent}
                                            projects={mergedProjects}
                                            removingKeys={removingKeys}
                                            activityView={activityView}
                                            dailyGoal={dailyGoal}
                                            onStart={handleStart}
                                            onStartAt={handleStartAt}
                                            onStop={handleStop}
                                            onShare={(project) => {
                                                setSharingProject(project);
                                                setView('sharing');
                                            }}
                                            onResume={handleResume}
                                            onUpdate={handleUpdate}
                                            onRemove={handleRemove}
                                        />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className={cn('h-full overflow-y-auto', pagePadding)}>
                                        <HistoryView
                                            activities={recent}
                                            sharedActivities={shared}
                                            graphActivities={pastYear}
                                            projects={mergedProjects}
                                            removingKeys={removingKeys}
                                            onUpdate={handleUpdate}
                                            onRemove={handleRemove}
                                            onResume={handleResume}
                                            onAddPast={handleAddPast}
                                            onOpenSharing={(project) => {
                                                setSharingProject(project);
                                                setView('sharing');
                                            }}
                                        />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className={cn('h-full overflow-y-auto', pagePadding)}>
                                    <ReportsView activities={summaryActivities} />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className={cn('h-full overflow-y-auto', pagePadding)}>
                                    <ChartsView activities={summaryActivities} />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className={cn('h-full overflow-y-auto', pagePadding)}>
                                    <StatsView activities={summaryActivities} />
                                    </div>
                                </SwiperSlide>
                            </Swiper>
                        </div>
                    )}
                    {view === 'settings' && (
                        <div className={pagePadding}>
                            <SettingsView
                                showAccount={showAccount}
                                onShowAccountChange={setShowAccount}
                                activityView={activityView}
                                onActivityViewChange={setActivityView}
                                dailyGoal={dailyGoal}
                                onDailyGoalChange={setDailyGoal}
                                showScrollbars={showScrollbars}
                                onShowScrollbarsChange={setShowScrollbars}
                                autoCompleteTodos={autoCompleteTodos}
                                onAutoCompleteTodosChange={setAutoCompleteTodos}
                                theme={theme}
                                onThemeChange={setTheme}
                                menuBar={menuBar}
                                onMenuBarChange={handleMenuBarChange}
                                onBack={() => setView('now')}
                            />
                        </div>
                    )}
                    {view === 'projects' && (
                        <div className={pagePadding}>
                            <ProjectsView
                                activities={summaryActivities}
                                running={running}
                                onChanged={loadColors}
                                onBack={() => setView('now')}
                            />
                        </div>
                    )}
                    {view === 'sharing' && (
                        <div className={pagePadding}>
                            <SharingView
                                projects={projects}
                                initialProject={sharingProject}
                                onBack={() => setView('history')}
                            />
                        </div>
                    )}
                    {view === 'teams' && (
                        <div className={pagePadding}>
                            <TeamsView
                                projects={projects}
                                selfUserID={authStatus?.user_id}
                                onInviteResolved={dismissInvite}
                                onOpenAccount={() => setView('account')}
                                onBack={() => setView('now')}
                            />
                        </div>
                    )}
                    {view === 'account' && (
                        <div className={pagePadding}>
                            <AccountView
                                running={running}
                                recent={recent}
                                projects={projects}
                                onStatusChange={setAuthStatus}
                                onBack={() => setView('now')}
                            />
                        </div>
                    )}
                </div>
            </main>
            <FinishTodoDialog
                description={finishingTodo?.description ?? null}
                onAnswer={answerFinishingTodo}
            />
            <Toaster position="bottom-right" richColors closeButton />
        </div>
        </CompactContext.Provider>
        </TeamsCacheContext.Provider>
        </ProjectSharesContext.Provider>
    );
}

export default App;
