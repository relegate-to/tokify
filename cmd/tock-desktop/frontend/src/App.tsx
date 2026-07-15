import { useEffect, useRef, useState } from 'react';
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
    ListRecent,
    ListToday,
    Projects,
    RemoveActivity,
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
import { Toaster } from '@/components/ui/sonner';
import { Masthead } from '@/components/Masthead';
import { NowView } from '@/components/NowView';
import { HistoryView } from '@/components/HistoryView';
import { SettingsView } from '@/components/SettingsView';
import { AccountView } from '@/components/AccountView';
import { SharingView } from '@/components/SharingView';
import { TeamsView } from '@/components/TeamsView';

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

        // Shared entries are best-effort and independent: a sharing/network error
        // (or sync being off) must never break the local activity refresh, so this
        // runs on its own and silently clears on failure.
        SharingSharedEntries()
            .then((entries) => setShared(mapShared(entries ?? [])))
            .catch(() => setShared([]));
    };

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(id);
    }, []);

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

    return (
        <div className="flex h-screen flex-col overflow-y-hidden bg-background text-foreground">
            <Masthead
                view={view}
                onView={handleView}
                running={running}
                showAccount={showAccount}
                account={authStatus}
                projects={projects}
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
                                            projects={projects}
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
                                            projects={projects}
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
                                    <LogPlaceholderView
                                            title="Reports"
                                            description="Weekly and monthly summaries will live here."
                                        />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
                                    <LogPlaceholderView
                                            title="Charts"
                                            description="Project and time breakdown charts will live here."
                                        />
                                    </div>
                            </SwiperSlide>
                            <SwiperSlide>
                                <div className="h-full overflow-y-auto px-8 pb-12 pt-[70px]">
                                    <LogPlaceholderView
                                            title="Stats"
                                            description="Streaks, averages, and totals will live here."
                                        />
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
    );
}

export default App;

function LogPlaceholderView({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="flex min-h-[360px] items-center justify-center rounded-xl border bg-muted/30 p-8 text-center">
            <div className="max-w-sm">
                <div className="mb-2 text-sm font-semibold tracking-wide text-foreground">
                    {title}
                </div>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
        </div>
    );
}
