import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
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

type Activity = models.Activity & { duration?: string };
type View = 'now' | 'history';

const REFRESH_MS = 30_000;
const TICK_MS = 1_000;
const EARLIER_DAYS = 7;
const HISTORY_LIMIT = 500;

function App() {
    const [view, setView] = useState<View>('now');
    const [running, setRunning] = useState<Activity | null>(null);
    const [today, setToday] = useState<Activity[]>([]);
    const [recent, setRecent] = useState<Activity[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
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
                setError(null);
            })
            .catch((e) => setError(String(e)));
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

    return (
        <div className="app">
            <div className="titlebar" aria-hidden />
            <Masthead view={view} onView={setView} />

            {error && <div className="notice">{error}</div>}

            {view === 'now' ? (
                <NowView
                    running={running}
                    today={today}
                    recent={recent}
                    projects={projects}
                    onStart={(d, p) =>
                        Start(d, p).then(refresh).catch((e) => setError(String(e)))
                    }
                    onStop={() =>
                        Stop().then(refresh).catch((e) => setError(String(e)))
                    }
                />
            ) : (
                <HistoryView
                    activities={recent}
                    projects={projects}
                    onUpdate={(orig, d, p) =>
                        UpdateActivity(orig, d, p)
                            .then(refresh)
                            .catch((e) => setError(String(e)))
                    }
                    onRemove={(orig) =>
                        RemoveActivity(orig)
                            .then(refresh)
                            .catch((e) => setError(String(e)))
                    }
                />
            )}
        </div>
    );
}

/* ── Masthead ──────────────────────────────────────────────────────────── */

function Masthead({
    view,
    onView,
}: {
    view: View;
    onView: (v: View) => void;
}) {
    const date = new Date()
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
    return (
        <header className="masthead">
            <div className="masthead__left">
                <h1 className="masthead__name">Toki</h1>
                <nav className="masthead__nav" aria-label="Sections">
                    <button
                        className={`masthead__nav-item${
                            view === 'now' ? ' masthead__nav-item--active' : ''
                        }`}
                        onClick={() => onView('now')}
                    >
                        Now
                    </button>
                    <span className="masthead__sep" aria-hidden>·</span>
                    <button
                        className={`masthead__nav-item${
                            view === 'history' ? ' masthead__nav-item--active' : ''
                        }`}
                        onClick={() => onView('history')}
                    >
                        History
                    </button>
                </nav>
            </div>
            <span className="masthead__date">{date}</span>
        </header>
    );
}

/* ── Now view ─────────────────────────────────────────────────────────── */

function NowView({
    running,
    today,
    recent,
    projects,
    onStart,
    onStop,
}: {
    running: Activity | null;
    today: Activity[];
    recent: Activity[];
    projects: string[];
    onStart: (description: string, project: string) => void;
    onStop: () => void;
}) {
    const todayTotal = useMemo(() => totalDuration(today), [today, running]);

    // Limit the "earlier" rail to a finite window — the rest lives in History.
    const earlier = useMemo(() => {
        const cutoff = startOfDay(new Date()).getTime() -
            EARLIER_DAYS * 24 * 60 * 60 * 1000;
        return recent.filter((a) => {
            const t = new Date(a.start_time as any).getTime();
            return t < startOfDay(new Date()).getTime() && t >= cutoff;
        });
    }, [recent]);

    return (
        <>
            {running ? (
                <NowRunning activity={running} onStop={onStop} />
            ) : (
                <Starter projects={projects} onStart={onStart} />
            )}

            <Logbook activities={today} totalMs={todayTotal} />

            <EarlierLog
                activities={earlier}
                emptyHint={`Past ${EARLIER_DAYS} days. Go to History for the full archive.`}
            />
        </>
    );
}

/* ── History view ─────────────────────────────────────────────────────── */

function HistoryView({
    activities,
    projects,
    onUpdate,
    onRemove,
}: {
    activities: Activity[];
    projects: string[];
    onUpdate: (orig: Activity, description: string, project: string) => void;
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
        <section className="history" aria-label="History">
            <HistorySearch
                query={query}
                onQuery={setQuery}
                count={filtered.length}
                total={finished.length}
            />
            {groups.length === 0 ? (
                <p className="logbook__empty">
                    {finished.length === 0
                        ? 'No finished activities yet.'
                        : 'No matches.'}
                </p>
            ) : (
                groups.map((g) => (
                    <DayGroup key={g.dateKey} day={g.date} activities={g.items}>
                        {(a) => (
                            <EditableLogRow
                                key={`${a.start_time}-${a.description}`}
                                activity={a}
                                projects={projects}
                                onUpdate={onUpdate}
                                onRemove={onRemove}
                            />
                        )}
                    </DayGroup>
                ))
            )}
        </section>
    );
}

function HistorySearch({
    query,
    onQuery,
    count,
    total,
}: {
    query: string;
    onQuery: (q: string) => void;
    count: number;
    total: number;
}) {
    return (
        <div className="search">
            <span className="search__caret" aria-hidden>⌕</span>
            <input
                className="search__input"
                type="text"
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder="Search description or project"
                autoComplete="off"
                spellCheck={false}
            />
            <span className="search__count">
                {query
                    ? `${count} of ${total}`
                    : `${total} ${total === 1 ? 'activity' : 'activities'}`}
            </span>
        </div>
    );
}

/* ── Now running headline ─────────────────────────────────────────────── */

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
                {activity.project || 'No project'}
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

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        onStart(trimmed, project.trim());
        setText('');
    };

    return (
        <section className="now starter" aria-label="Start a new activity">
            <p className="now__eyebrow now__eyebrow--idle">Nothing running</p>

            <div className="starter__field">
                <span className="starter__caret" aria-hidden>→</span>
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

            <ProjectField
                value={project}
                onChange={setProject}
                suggestions={projects}
                onSubmit={submit}
            />

            <div className="starter__row">
                <span />
                <span className="starter__hint">enter to start</span>
            </div>
        </section>
    );
}

/* ── ProjectField — typeable input with chip shortcuts ────────────────── */

function ProjectField({
    value,
    onChange,
    suggestions,
    onSubmit,
}: {
    value: string;
    onChange: (v: string) => void;
    suggestions: string[];
    onSubmit?: () => void;
}) {
    return (
        <div className="project-field">
            <span className="project-field__label">in</span>
            <input
                className="project-field__input"
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && onSubmit) onSubmit();
                }}
                placeholder="project (optional)"
                autoComplete="off"
                spellCheck={false}
            />
            <div className="project-field__chips">
                {suggestions.map((p) => (
                    <button
                        key={p}
                        type="button"
                        className={`project-field__chip${
                            value === p ? ' project-field__chip--active' : ''
                        }`}
                        onClick={() => onChange(value === p ? '' : p)}
                    >
                        {p}
                    </button>
                ))}
            </div>
        </div>
    );
}

/* ── Logbook (today, read-only) ───────────────────────────────────────── */

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
                    {distinctProjects > 0 &&
                        ` · ${distinctProjects} project${distinctProjects === 1 ? '' : 's'}`}
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

/* ── LogRow — read-only ───────────────────────────────────────────────── */

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

/* ── EditableLogRow — used by History ─────────────────────────────────── */

function EditableLogRow({
    activity,
    projects,
    onUpdate,
    onRemove,
}: {
    activity: Activity;
    projects: string[];
    onUpdate: (orig: Activity, description: string, project: string) => void;
    onRemove: (orig: Activity) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [desc, setDesc] = useState(activity.description ?? '');
    const [project, setProject] = useState(activity.project ?? '');
    const [confirmRemove, setConfirmRemove] = useState(false);
    const descRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) descRef.current?.focus();
    }, [editing]);

    const start = new Date(activity.start_time as any);
    const end = activity.end_time ? new Date(activity.end_time as any) : null;
    const ms = (end?.getTime() ?? Date.now()) - start.getTime();

    const save = () => {
        if (!desc.trim()) return;
        onUpdate(activity, desc, project);
        setEditing(false);
    };
    const cancel = () => {
        setDesc(activity.description ?? '');
        setProject(activity.project ?? '');
        setEditing(false);
        setConfirmRemove(false);
    };

    if (editing) {
        return (
            <li className="logbook__row logbook__row--editing">
                <span className="logbook__time">{formatClock(start)}</span>
                <div className="logbook__entry">
                    <input
                        ref={descRef}
                        className="row-edit__desc"
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') save();
                            if (e.key === 'Escape') cancel();
                        }}
                        placeholder="Description"
                    />
                    <ProjectField
                        value={project}
                        onChange={setProject}
                        suggestions={projects}
                    />
                    <div className="row-edit__actions">
                        <button className="row-edit__save" onClick={save}>
                            Save
                        </button>
                        <button className="row-edit__cancel" onClick={cancel}>
                            Cancel
                        </button>
                        {!confirmRemove ? (
                            <button
                                className="row-edit__remove"
                                onClick={() => setConfirmRemove(true)}
                            >
                                Remove
                            </button>
                        ) : (
                            <span className="row-edit__confirm">
                                Remove this for good?
                                <button
                                    className="row-edit__remove row-edit__remove--confirm"
                                    onClick={() => onRemove(activity)}
                                >
                                    Yes, remove
                                </button>
                                <button
                                    className="row-edit__cancel"
                                    onClick={() => setConfirmRemove(false)}
                                >
                                    Keep it
                                </button>
                            </span>
                        )}
                    </div>
                </div>
                <span className="logbook__duration">{formatDuration(ms)}</span>
            </li>
        );
    }

    return (
        <li
            className="logbook__row logbook__row--editable"
            onClick={() => setEditing(true)}
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditing(true);
                }
            }}
            role="button"
            aria-label={`Edit ${activity.description}`}
        >
            <span className="logbook__time">{formatClock(start)}</span>
            <div className="logbook__entry">
                {activity.project && (
                    <span className="logbook__project">{activity.project}</span>
                )}
                <span className="logbook__desc">
                    {activity.description || 'No description'}
                </span>
            </div>
            <span className="logbook__duration">{formatDuration(ms)}</span>
        </li>
    );
}

/* ── EarlierLog and DayGroup (parameterized) ──────────────────────────── */

function EarlierLog({
    activities,
    emptyHint,
}: {
    activities: Activity[];
    emptyHint?: string;
}) {
    const groups = useMemo(() => groupByLocalDate(activities, false), [activities]);
    if (groups.length === 0) {
        return emptyHint ? (
            <section className="earlier" aria-label="Earlier activities">
                <header className="earlier__header">
                    <h2 className="earlier__title">Earlier</h2>
                </header>
                <p className="logbook__empty">{emptyHint}</p>
            </section>
        ) : null;
    }
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
    children,
}: {
    day: Date;
    activities: Activity[];
    children?: (a: Activity) => React.ReactNode;
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
                {activities.map((a, i) =>
                    children
                        ? children(a)
                        : <LogRow key={`${a.start_time}-${i}`} activity={a} />,
                )}
            </ol>
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
        return d.toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase();
    }
    return d
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
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
