import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { buildClockISO, formatClock, formatDuration } from '@/lib/time';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProjectTag } from '@/components/ProjectTag';

const ROW_HEIGHT = 'h-11';
const ROW_GRID =
    'grid grid-cols-[4rem_minmax(0,1fr)_5rem_auto] items-center gap-3 px-3';

export function ActivityRow({
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
                <div className="flex min-w-0 items-center gap-2.5">
                    {activity.project && (
                        <ProjectTag
                            project={activity.project}
                            className="max-w-32 shrink-0"
                        />
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
