import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import type { Activity } from '@/types';
import { buildClockISO, formatClock } from '@/lib/time';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ProjectField } from '@/components/ProjectField';

export function EditActivityDialog({
    open,
    onOpenChange,
    activity,
    projects,
    onUpdate,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    activity: Activity;
    projects: string[];
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
}) {
    const start = new Date(activity.start_time as any);
    const end = activity.end_time ? new Date(activity.end_time as any) : null;
    const isRunning = !end;

    const [desc, setDesc] = useState(activity.description ?? '');
    const [project, setProject] = useState(activity.project ?? '');
    const [startStr, setStartStr] = useState(formatClock(start));
    const [endStr, setEndStr] = useState(end ? formatClock(end) : '');

    // Re-seed from the activity each time the dialog opens, so reopening after a
    // cancel (or editing a different row) always starts from the saved values.
    useEffect(() => {
        if (!open) return;
        setDesc(activity.description ?? '');
        setProject(activity.project ?? '');
        setStartStr(formatClock(start));
        setEndStr(end ? formatClock(end) : '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, activity.description, activity.project, activity.start_time, activity.end_time]);

    const submit = () => {
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
            if (new Date(built).getTime() <= new Date(startISO).getTime()) {
                toast.error('End must be after start');
                return;
            }
            endISO = built;
        }
        onUpdate(activity, trimmed, project.trim(), startISO, endISO);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Edit activity</DialogTitle>
                    <DialogDescription>
                        {isRunning
                            ? `Started ${format(start, 'EEE, d MMM')} — still running.`
                            : `Tracked ${format(start, 'EEE, d MMM')}.`}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Description
                        </label>
                        <Input
                            autoFocus
                            value={desc}
                            onChange={(e) => setDesc(e.target.value)}
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
                            placeholder="project (optional)"
                        />
                    </div>
                    <div className="flex items-end gap-2">
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
                        {end && (
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
                        )}
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit}>Save changes</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
