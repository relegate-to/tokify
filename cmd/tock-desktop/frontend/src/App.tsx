import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    Projects,
    RemoveActivity,
    SharingListTeams,
    SharingProjectShares,
    SharingSharedEntries,
    Start,
    StartAt,
    Stop,
    TeamsGetStatus,
    UpdateActivity,
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { main, neonauth, teams } from '../wailsjs/go/models';

import type { Activity, ActivityItem, ActivityView, Theme, View } from '@/types';
import { REMOVE_ANIM_MS } from '@/lib/motion';
import { setProjectColorOverrides } from '@/lib/colors';
import {
    ProjectSharesContext,
    type ProjectSharesMap,
} from '@/lib/project-shares';
import { TeamsCacheContext } from '@/lib/teams-cache';
import { Toaster } from '@/components/ui/sonner';
import { Masthead } from '@/components/Masthead';
import { NowView } from '@/components/NowView';
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
const DEFAULT_DAILY_GOAL = 360;
const DAILY_GOAL_VALUES = [240, 360, 480];
const ACTIVITY_VIEW_VALUES: ActivityView[] = ['all', 'today', 'none'];
const LOG_VIEWS: View[] = ['history', 'reports', 'charts', 'stats'];
const SWIPE_VIEWS: View[] = ['now', ...LOG_VIEWS];

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
                    teamName: e.team_name,
                },
            }) as ActivityItem,
    );
}

function App() {
    const [view, setView] = useState<View>('now');
    const [sharingProject, setSharingProject] = useState<string | undefined>();
    const [running, setRunning] = useState<Activity | null>(null);
    const [today, setToday] = useState<Activity[]>([]);
    const [pastYear, setPastYear] = useState<Activity[]>([]);
    const [recent, setRecent] = useState<Activity[]>([]);
    const [shared, setShared] = useState<ActivityItem[]>([]);
    const [pendingInvites, setPendingInvites] = useState<main.TeamView[]>([]);
    const [teams, setTeams] = useState<main.TeamView[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [projectShares, setProjectShares] = useState<ProjectSharesMap>({});
    const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set());
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
    const [teamsStatus, setTeamsStatus] = useState<teams.Status | null>(null);
    const [authStatus, setAuthStatus] = useState<neonauth.Status | null>(null);
    const viewRef = useRef<View>(view);
    const logSwiperRef = useRef<SwiperInstance | null>(null);
    const programmaticSlide = useRef(false);
    const programmaticTimer = useRef<number | null>(null);

    viewRef.current = view;

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
            ListPastYear(),
            ListRecent(HISTORY_LIMIT),
            Projects(),
        ])
            .then(([r, t, year, all, p]) => {
                setRunning((r as Activity) ?? null);
                setToday((t as Activity[]) ?? []);
                setPastYear((year as Activity[]) ?? []);
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
                    if (!cancelled) setShared(mapShared(entries ?? []));
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
            if (!cancelled) setShared(mapShared(entries ?? []));
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

    const isSwipeView = SWIPE_VIEWS.includes(view);

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
        <div className="flex h-screen flex-col overflow-y-hidden bg-background text-foreground">
            <Masthead
                view={view}
                onView={handleView}
                running={running}
                showAccount={showAccount}
                account={authStatus}
                projects={mergedProjects}
                invites={pendingInvites}
                hasShared={shared.length > 0}
            />
            <main className={`flex-1 overflow-x-visible overscroll-none ${isSwipeView ? 'overflow-hidden' : 'overflow-y-auto'}`}>
                <div className="flex h-full w-full flex-col">
                    {isSwipeView && (
                        <div className="h-full overflow-visible">
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
                                    if (next && next !== viewRef.current) setView(next);
                                }}
                        >
                            <SwiperSlide>
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
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
                                        />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
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
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
                                    <ReportsView activities={summaryActivities} />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
                                    <ChartsView activities={summaryActivities} />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
                                    <StatsView activities={summaryActivities} />
                                    </div>
                                </SwiperSlide>
                            </Swiper>
                        </div>
                    )}
                    {view === 'settings' && (
                        <div className="px-8 pb-12 pt-[70px]">
                            <SettingsView
                                showAccount={showAccount}
                                onShowAccountChange={setShowAccount}
                                activityView={activityView}
                                onActivityViewChange={setActivityView}
                                dailyGoal={dailyGoal}
                                onDailyGoalChange={setDailyGoal}
                                showScrollbars={showScrollbars}
                                onShowScrollbarsChange={setShowScrollbars}
                                theme={theme}
                                onThemeChange={setTheme}
                                projects={projects}
                                teamsStatus={teamsStatus}
                                onTeamsRefresh={refreshTeams}
                                onBack={() => setView('now')}
                            />
                        </div>
                    )}
                    {view === 'projects' && (
                        <div className="px-8 pb-12 pt-[70px]">
                            <ProjectsView
                                activities={summaryActivities}
                                running={running}
                                onChanged={loadColors}
                                onBack={() => setView('now')}
                            />
                        </div>
                    )}
                    {view === 'sharing' && (
                        <div className="px-8 pb-12 pt-[70px]">
                            <SharingView
                                projects={projects}
                                initialProject={sharingProject}
                                onBack={() => setView('history')}
                            />
                        </div>
                    )}
                    {view === 'teams' && (
                        <div className="px-8 pb-12 pt-[70px]">
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
                        <div className="px-8 pb-12 pt-[70px]">
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
            <Toaster position="bottom-right" richColors closeButton />
        </div>
        </TeamsCacheContext.Provider>
        </ProjectSharesContext.Provider>
    );
}

export default App;
