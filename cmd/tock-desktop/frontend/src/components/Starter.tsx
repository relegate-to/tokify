import { useEffect, useRef, useState } from 'react';
import { Clock, Play, X } from 'lucide-react';
import { toast } from 'sonner';

import { EASE_THUNK } from '@/lib/motion';
import { buildClockISO, formatClock } from '@/lib/time';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput,
} from '@/components/ui/input-group';
import { ProjectField } from '@/components/ProjectField';

export function Starter({
    projects,
    onStart,
    onStartAt,
}: {
    projects: string[];
    onStart: (description: string, project: string) => void;
    onStartAt: (description: string, project: string, startISO: string) => void;
}) {
    const [text, setText] = useState('');
    const [project, setProject] = useState('');
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
            className="flex min-h-[140px] flex-col justify-center gap-3 rounded-xl border bg-card p-4 shadow-sm animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-400"
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
