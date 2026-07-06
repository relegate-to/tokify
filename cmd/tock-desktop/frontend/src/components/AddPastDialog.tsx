import { useEffect, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { buildClockISO, startOfDay } from '@/lib/time';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { ProjectField } from '@/components/ProjectField';

export function AddPastButton({
    projects,
    onAddPast,
}: {
    projects: string[];
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Plus className="size-3.5" />
                Add past activity
            </button>
            <AddPastDialog
                open={open}
                onOpenChange={setOpen}
                projects={projects}
                onAddPast={onAddPast}
            />
        </>
    );
}

function AddPastDialog({
    open,
    onOpenChange,
    projects,
    onAddPast,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    projects: string[];
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
}) {
    const [description, setDescription] = useState('');
    const [project, setProject] = useState('');
    const [date, setDate] = useState<Date>(() => startOfDay(new Date()));
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [startStr, setStartStr] = useState('09:00');
    const [endStr, setEndStr] = useState('10:00');

    useEffect(() => {
        if (!open) return;
        setDescription('');
        setProject('');
        setDate(startOfDay(new Date()));
        setStartStr('09:00');
        setEndStr('10:00');
    }, [open]);

    const submit = () => {
        const trimmed = description.trim();
        if (!trimmed) {
            toast.error('Description cannot be empty');
            return;
        }
        const startISO = buildClockISO(date, startStr);
        if (startISO === null) {
            toast.error('Start must be HH:MM');
            return;
        }
        const endISO = buildClockISO(date, endStr);
        if (endISO === null) {
            toast.error('End must be HH:MM');
            return;
        }
        if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
            toast.error('End must be after start');
            return;
        }
        onAddPast(trimmed, project.trim(), startISO, endISO);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add past activity</DialogTitle>
                    <DialogDescription>
                        Record something you tracked offline. The activity is
                        saved as completed.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Description
                        </label>
                        <Input
                            autoFocus
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
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
                            onSubmit={submit}
                            placeholder="project (optional)"
                        />
                    </div>
                    <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs text-muted-foreground">
                                Date
                            </label>
                            <Popover
                                open={datePickerOpen}
                                onOpenChange={setDatePickerOpen}
                            >
                                <PopoverTrigger
                                    type="button"
                                    className="inline-flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm font-normal transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                                >
                                    {format(date, 'EEE, d MMM yyyy')}
                                    <ChevronDown className="size-4 opacity-60" />
                                </PopoverTrigger>
                                <PopoverContent
                                    className="z-[60] w-auto overflow-hidden p-0"
                                    align="start"
                                >
                                    <Calendar
                                        mode="single"
                                        selected={date}
                                        captionLayout="dropdown"
                                        onSelect={(d) => {
                                            if (!d) return;
                                            setDate(startOfDay(d));
                                            setDatePickerOpen(false);
                                        }}
                                    />
                                </PopoverContent>
                            </Popover>
                        </div>
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
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit}>Add</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
