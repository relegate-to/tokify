import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { Export } from '../../wailsjs/go/main/App';

import { cn } from '@/lib/utils';
import { startOfDay } from '@/lib/time';
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
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { ProjectField } from '@/components/ProjectField';

type ExportFormat = 'txt' | 'csv' | 'json';
type ExportRange = 'all' | 'today' | 'yesterday' | 'custom';

const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
    { value: 'txt', label: 'Text' },
    { value: 'csv', label: 'CSV' },
    { value: 'json', label: 'JSON' },
];

const EXPORT_RANGES: { value: ExportRange; label: string }[] = [
    { value: 'all', label: 'All time' },
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'custom', label: 'Range' },
];

function toDateISO(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function resolveExportRange(
    range: ExportRange,
    fromDate: Date,
    toDate: Date,
): { from: string; to: string } {
    if (range === 'all') return { from: '', to: '' };
    if (range === 'today') {
        const t = toDateISO(new Date());
        return { from: t, to: t };
    }
    if (range === 'yesterday') {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        const iso = toDateISO(y);
        return { from: iso, to: iso };
    }
    return { from: toDateISO(fromDate), to: toDateISO(toDate) };
}

export function ExportDialog({
    open,
    onOpenChange,
    projects,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    projects: string[];
}) {
    const [format, setFormat] = useState<ExportFormat>('txt');
    const [range, setRange] = useState<ExportRange>('all');
    const [fromDate, setFromDate] = useState<Date>(() => startOfDay(new Date()));
    const [toDate, setToDate] = useState<Date>(() => startOfDay(new Date()));
    const [fromOpen, setFromOpen] = useState(false);
    const [toOpen, setToOpen] = useState(false);
    const [project, setProject] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setFormat('txt');
        setRange('all');
        setFromDate(startOfDay(new Date()));
        setToDate(startOfDay(new Date()));
        setProject('');
        setSaving(false);
    }, [open]);

    const submit = () => {
        if (range === 'custom' && fromDate.getTime() > toDate.getTime()) {
            toast.error('From must not be after To');
            return;
        }
        const { from, to } = resolveExportRange(range, fromDate, toDate);
        setSaving(true);
        Export(format, from, to, project.trim())
            .then((path) => {
                if (path) {
                    toast.success('Exported', { description: path });
                    onOpenChange(false);
                }
            })
            .catch((e) => toast.error(String(e)))
            .finally(() => setSaving(false));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Export activities</DialogTitle>
                    <DialogDescription>
                        Filter what's saved. You'll pick the destination next.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Format
                        </label>
                        <SegmentedRow
                            value={format}
                            options={EXPORT_FORMATS}
                            onChange={setFormat}
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">
                            Date range
                        </label>
                        <SegmentedRow
                            value={range}
                            options={EXPORT_RANGES}
                            onChange={setRange}
                        />
                        {range === 'custom' && (
                            <div className="mt-1 grid grid-cols-2 gap-2">
                                <DatePickerField
                                    label="From"
                                    value={fromDate}
                                    open={fromOpen}
                                    onOpenChange={setFromOpen}
                                    onSelect={(d) => {
                                        setFromDate(startOfDay(d));
                                        setFromOpen(false);
                                    }}
                                />
                                <DatePickerField
                                    label="To"
                                    value={toDate}
                                    open={toOpen}
                                    onOpenChange={setToOpen}
                                    onSelect={(d) => {
                                        setToDate(startOfDay(d));
                                        setToOpen(false);
                                    }}
                                />
                            </div>
                        )}
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
                            placeholder="all projects"
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={saving}>
                        {saving ? 'Saving…' : 'Save…'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SegmentedRow<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div
            role="radiogroup"
            className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
        >
            {options.map((opt) => {
                const active = value === opt.value;
                return (
                    <button
                        key={opt.value}
                        role="radio"
                        aria-checked={active}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            'flex-1 rounded px-3 py-1 text-xs transition-colors',
                            active
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

function DatePickerField({
    label,
    value,
    open,
    onOpenChange,
    onSelect,
}: {
    label: string;
    value: Date;
    open: boolean;
    onOpenChange: (v: boolean) => void;
    onSelect: (d: Date) => void;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">{label}</label>
            <Popover open={open} onOpenChange={onOpenChange}>
                <PopoverTrigger
                    type="button"
                    className="inline-flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm font-normal transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                >
                    {format(value, 'd MMM yyyy')}
                    <ChevronDown className="size-4 opacity-60" />
                </PopoverTrigger>
                <PopoverContent
                    className="z-[60] w-auto overflow-hidden p-0"
                    align="start"
                >
                    <Calendar
                        mode="single"
                        selected={value}
                        captionLayout="dropdown"
                        onSelect={(d) => {
                            if (!d) return;
                            onSelect(d);
                        }}
                    />
                </PopoverContent>
            </Popover>
        </div>
    );
}
