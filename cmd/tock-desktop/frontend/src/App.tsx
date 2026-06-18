import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
    GetRunning,
    ListRecent,
    ListToday,
    Projects,
    Start,
    Stop,
} from '../wailsjs/go/main/App';
import { models } from '../wailsjs/go/models';

type Activity = models.Activity & { duration?: string };

const REFRESH_MS = 30_000;
const TICK_MS = 1_000;

function App() {
    const [running, setRunning] = useState<Activity | null>(null);
    const [today, setToday] = useState<Activity[]>([]);
    const [recent, setRecent] = useState<Activity[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = () => {
        Promise.all([GetRunning(), ListToday(), ListRecent(200), Projects()])
            .then(([r, t, all, p]) => {
                setRunning((r as Activity) ?? null);
                setToday((t as Activity[]) ?? []);
                setRecent((all as Activity[]) ?? []);
                setProjects(p ?? []);
                setError(null);
            })
            .catch((e) => setError(String(e)));
    };

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(id);
    }, []);

    // Tick once a second so the live duration counts up.
    useEffect(() => {
        if (!running) return;
        const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
        return () => clearInterval(id);
    }, [running]);

    const todayTotal = useMemo(() => {
        let ms = 0;
        for (const a of today) {
            const end = a.end_time ? new Date(a.end_time as any).getTime() : Date.now();
            ms += end - new Date(a.start_time as any).getTime();
        }
        return ms;
    }, [today, tick]);

    return (
        <div className="app">
            <div className="titlebar" aria-hidden />
            <Masthead />

            {running ? (
                <NowRunning
                    activity={running}
                    onStop={() =>
                        Stop()
                            .then(() => refresh())
                            .catch((e) => setError(String(e)))
                    }
                />
            ) : (
                <Starter
                    projects={projects}
                    onStart={(description, project) =>
                        Start(description, project)
                            .then(() => refresh())
                            .catch((e) => setError(String(e)))
                    }
                />
            )}

            {error && <div className="notice">{error}</div>}

            <Logbook activities={today} totalMs={todayTotal} />

            <EarlierLog activities={recent} />
        </div>
    );
}

function Masthead() {
    const now = new Date();
    const date = now
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
    return (
        <header className="masthead">
            <h1 className="masthead__name">Toki</h1>
            <span className="masthead__date">{date}</span>
        </header>
    );
}

function NowRunning({
    activity,
    onStop,
}: {
    activity: Activity;
    onStop: () => void;
}) {
    const since = new Date(activity.start_time as any);
    const ms = Date.now() - since.getTime();
    return (
        <section className="now" aria-label="Currently running">
            <p className={`now__eyebrow${activity.project ? '' : ' now__eyebrow--idle'}`}>
                {activity.project ? activity.project : 'Untracked project'}
            </p>
            <p className="now__desc">{activity.description || 'No description'}</p>
            <div className="now__duration" aria-live="polite">
                {formatDuration(ms)}
            </div>
            <div className="now__meta">since {formatClock(since)}</div>
            <div className="now__actions">
                <button className="now__stop" onClick={onStop}>
                    Stop
                </button>
            </div>
        </section>
    );
}

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

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        onStart(trimmed, project);
        setText('');
    };

    return (
        <section className="now starter" aria-label="Start a new activity">
            <p className="now__eyebrow now__eyebrow--idle">Nothing running</p>
            <div className="starter__field">
                <span className="starter__caret" aria-hidden>
                    →
                </span>
                <input
                    ref={inputRef}
                    className="starter__input"
                    type="text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                    placeholder="What are you working on?"
                    autoComplete="off"
                    spellCheck={false}
                />
            </div>
            <div className="starter__row">
                <div className="starter__project-chips">
                    {projects.map((p) => (
                        <button
                            key={p}
                            type="button"
                            className={`starter__chip${
                                project === p ? ' starter__chip--selected' : ''
                            }`}
                            onClick={() => setProject(project === p ? '' : p)}
                        >
                            {p}
                        </button>
                    ))}
                </div>
                <span className="starter__hint">enter to start</span>
            </div>
        </section>
    );
}

function Logbook({
    activities,
    totalMs,
}: {
    activities: Activity[];
    totalMs: number;
}) {
    const distinctProjects = new Set(
        activities.map((a) => a.project).filter(Boolean),
    ).size;

    return (
        <section className="logbook" aria-label="Today's logbook">
            <header className="logbook__header">
                <h2 className="logbook__title">Today</h2>
                <span className="logbook__total">
                    {formatTotal(totalMs)}
                    {distinctProjects > 0 && ` · ${distinctProjects} project${distinctProjects === 1 ? '' : 's'}`}
                </span>
            </header>
            {activities.length === 0 ? (
                <p className="logbook__empty">Nothing tracked today.</p>
            ) : (
                <ol className="logbook__list">
                    {activities.map((a, i) => (
                        <LogRow key={`${a.start_time}-${i}`} activity={a} />
                    ))}
                </ol>
            )}
        </section>
    );
}

function LogRow({ activity }: { activity: Activity }) {
    const start = new Date(activity.start_time as any);
    const end = activity.end_time ? new Date(activity.end_time as any) : null;
    const ms = (end?.getTime() ?? Date.now()) - start.getTime();
    const isRunning = !end;
    return (
        <li className="logbook__row">
            <span className="logbook__time">{formatClock(start)}</span>
            <div className="logbook__entry">
                {activity.project && (
                    <span
                        className={`logbook__project${
                            isRunning ? ' logbook__project--running' : ''
                        }`}
                    >
                        {activity.project}
                    </span>
                )}
                <span className="logbook__desc">
                    {activity.description || 'No description'}
                </span>
            </div>
            <span
                className={`logbook__duration${
                    isRunning ? ' logbook__duration--running' : ''
                }`}
            >
                {formatDuration(ms)}
            </span>
        </li>
    );
}

function EarlierLog({ activities }: { activities: Activity[] }) {
    const groups = useMemo(() => groupByLocalDate(activities), [activities]);
    if (groups.length === 0) return null;
    return (
        <section className="earlier" aria-label="Earlier activities">
            <header className="earlier__header">
                <h2 className="earlier__title">Earlier</h2>
            </header>
            {groups.map((g) => (
                <DayGroup key={g.dateKey} day={g.date} activities={g.items} />
            ))}
        </section>
    );
}

function DayGroup({
    day,
    activities,
}: {
    day: Date;
    activities: Activity[];
}) {
    const totalMs = activities.reduce((sum, a) => {
        const startMs = new Date(a.start_time as any).getTime();
        const endMs = a.end_time
            ? new Date(a.end_time as any).getTime()
            : startMs;
        return sum + (endMs - startMs);
    }, 0);
    return (
        <div className="day">
            <header className="day__header">
                <h3 className="day__label">{dayLabel(day)}</h3>
                <span className="day__total">{formatTotal(totalMs)}</span>
            </header>
            <ol className="logbook__list">
                {activities.map((a, i) => (
                    <LogRow key={`${a.start_time}-${i}`} activity={a} />
                ))}
            </ol>
        </div>
    );
}

function startOfDay(d: Date) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function groupByLocalDate(
    activities: Activity[],
): { dateKey: string; date: Date; items: Activity[] }[] {
    const today = startOfDay(new Date()).getTime();
    const buckets = new Map<string, { date: Date; items: Activity[] }>();

    // Activities arrive newest-first from the server; we want oldest entries
    // within each day at the top so a day reads chronologically downward.
    for (const a of activities) {
        const start = new Date(a.start_time as any);
        const dayStart = startOfDay(start);
        if (dayStart.getTime() >= today) continue;
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
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) {
        return d
            .toLocaleDateString(undefined, { weekday: 'long' })
            .toLowerCase();
    }
    return d
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
}

function pad(n: number) {
    return n < 10 ? `0${n}` : String(n);
}

function formatClock(d: Date) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
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
