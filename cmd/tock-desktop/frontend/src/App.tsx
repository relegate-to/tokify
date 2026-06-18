import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
    GetRunning,
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
    const [projects, setProjects] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = () => {
        Promise.all([GetRunning(), ListToday(), Projects()])
            .then(([r, t, p]) => {
                setRunning((r as Activity) ?? null);
                setToday((t as Activity[]) ?? []);
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
                    {activities.map((a, i) => {
                        const start = new Date(a.start_time as any);
                        const end = a.end_time ? new Date(a.end_time as any) : null;
                        const ms = (end?.getTime() ?? Date.now()) - start.getTime();
                        const isRunning = !end;
                        return (
                            <li
                                key={`${a.start_time}-${i}`}
                                className="logbook__row"
                            >
                                <span className="logbook__time">{formatClock(start)}</span>
                                <div className="logbook__entry">
                                    {a.project && (
                                        <span
                                            className={`logbook__project${
                                                isRunning ? ' logbook__project--running' : ''
                                            }`}
                                        >
                                            {a.project}
                                        </span>
                                    )}
                                    <span className="logbook__desc">
                                        {a.description || 'No description'}
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
                    })}
                </ol>
            )}
        </section>
    );
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
