import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';

import { EASE_THUNK } from '@/lib/motion';
import { buildClockISO, formatClock } from '@/lib/time';
import { Input } from '@/components/ui/input';
import { ProjectPicker } from '@/components/ProjectPicker';

export function Starter({
    projects,
    lastStop,
    defaultProject,
    onStart,
    onStartAt,
}: {
    projects: string[];
    lastStop: Date | null;
    defaultProject: string;
    onStart: (description: string, project: string) => void;
    onStartAt: (description: string, project: string, startISO: string) => void;
}) {
    const [text, setText] = useState('');
    const [project, setProject] = useState(defaultProject);
    // Activities load after this mounts, so adopt the default until the picker
    // is touched; after that the choice is the user's.
    const projectTouched = useRef(false);
    const [startAt, setStartAt] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const startAtRef = useRef<HTMLInputElement>(null);
    const startAtOpen = startAt !== null;

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (startAtOpen) startAtRef.current?.focus();
    }, [startAtOpen]);

    useEffect(() => {
        if (!projectTouched.current) setProject(defaultProject);
    }, [defaultProject]);

    const canStart = text.trim().length > 0;

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed) {
            inputRef.current?.focus();
            return;
        }
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
            className="flex min-h-[140px] items-center gap-[34px] rounded-[16px] bg-card px-[34px] py-[30px] shadow-[inset_0_0_0_1px_var(--border)] animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-400"
            style={{ animationTimingFunction: EASE_THUNK }}
        >
            <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
                <div className="flex items-center gap-[9px]">
                    <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-idle-dot"
                    />
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-navigation-muted-foreground">
                        Nothing running
                        {lastStop && ` · last stop ${formatClock(lastStop)}`}
                    </span>
                </div>

                <input
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                    placeholder="What are you working on?"
                    aria-label="What are you working on?"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full bg-transparent text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground outline-none placeholder:select-none placeholder:text-ink-faint"
                />

                <div className="flex h-6 min-w-0 items-center gap-3.5">
                    <ProjectPicker
                        value={project}
                        onChange={(next) => {
                            projectTouched.current = true;
                            setProject(next);
                        }}
                        suggestions={projects}
                    />
                    <span
                        aria-hidden
                        className="h-[13px] w-px shrink-0 bg-border"
                    />
                    {startAt === null ? (
                        <button
                            type="button"
                            onClick={() => setStartAt(formatClock(new Date()))}
                            className="shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
                        >
                            Started earlier…
                        </button>
                    ) : (
                        <div className="flex items-center gap-2 animate-in fade-in-0 slide-in-from-left-1 duration-200">
                            <span className="text-sm text-muted-foreground">
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
                                aria-label="Start time"
                                className="h-6 w-[70px] px-2 text-center font-mono text-xs tabular-nums"
                            />
                            <button
                                type="button"
                                onClick={() => setStartAt(null)}
                                className="text-muted-foreground transition-colors hover:text-foreground"
                                title="Clear"
                                aria-label="Clear start time"
                            >
                                <X className="size-3.5" />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <button
                type="button"
                onClick={submit}
                aria-disabled={!canStart}
                className="flex shrink-0 items-center gap-[9px] rounded-[10px] bg-primary px-[22px] py-3 text-sm font-semibold text-primary-foreground transition-[background-color,opacity,transform] hover:bg-primary-hover active:scale-95"
            >
                <span
                    aria-hidden
                    className="size-0 border-y-[5px] border-l-[8px] border-y-transparent border-l-current"
                />
                Start
            </button>
        </section>
    );
}
