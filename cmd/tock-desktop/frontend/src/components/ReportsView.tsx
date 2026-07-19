import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';

import type { Activity } from '@/types';
import { buildReport } from '@/lib/summary';
import { formatTotal } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import {
    Band,
    Eyebrow,
    MixRibbon,
    Panel,
    Segmented,
    StackedBarChart,
} from '@/components/SummaryBits';

export function ReportsView({ activities }: { activities: Activity[] }) {
    const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
    const [offset, setOffset] = useState(0);

    const rep = useMemo(
        () => buildReport(activities, period, offset),
        [activities, period, offset],
    );

    const switchPeriod = (p: 'weekly' | 'monthly') => {
        setPeriod(p);
        setOffset(0);
    };

    const DeltaIcon = rep.up ? ArrowUpRight : ArrowDownRight;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                    <StepButton
                        onClick={() => setOffset((o) => o - 1)}
                        aria-label="Previous period"
                    >
                        <ChevronLeft className="size-4" />
                    </StepButton>
                    <div className="min-w-[176px] text-center text-[17px] font-semibold tracking-tight text-foreground">
                        {rep.periodLabel}
                    </div>
                    <StepButton
                        onClick={() => setOffset((o) => Math.min(0, o + 1))}
                        disabled={offset >= 0}
                        aria-label="Next period"
                    >
                        <ChevronRight className="size-4" />
                    </StepButton>
                </div>
                <Segmented
                    value={period}
                    onChange={switchPeriod}
                    options={[
                        { value: 'weekly', label: 'Weekly' },
                        { value: 'monthly', label: 'Monthly' },
                    ]}
                />
            </div>

            <Band className="animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
                <div className="mb-3 flex items-start justify-between gap-6">
                    <div className="min-w-0">
                        <Eyebrow className="mb-2">{rep.eyebrow}</Eyebrow>
                        <div className="flex items-baseline gap-3">
                            <div className="font-mono text-[42px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-foreground">
                                {formatTotal(rep.totalMs)}
                            </div>
                            {rep.hasPrev && (
                                <div className="flex items-center gap-1 text-[13px] font-medium tabular-nums text-day-total-foreground">
                                    <DeltaIcon className="size-3.5 text-muted-foreground" />
                                    {rep.up ? '+' : '−'}
                                    {formatTotal(Math.abs(rep.deltaMs))}
                                    <span className="text-muted-foreground/70">
                                        {' '}
                                        · {rep.up ? '+' : '−'}
                                        {Math.abs(rep.deltaPct)}% vs prev
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-stretch gap-6">
                        <SummaryStat value={formatTotal(rep.avgMs)} label={rep.avgSub} />
                        <div className="w-px bg-border" />
                        <SummaryStat value={rep.trackedLabel} label="days tracked" />
                    </div>
                </div>

                <MixRibbon mix={rep.mix} total={rep.totalMs} />

                <div className="mt-4">
                    <StackedBarChart bars={rep.bars} heightClass="h-[104px]" barMaxWidth={34} />
                </div>
            </Band>

            <div
                className={
                    rep.tasks.length > 0
                        ? 'grid items-start gap-4 lg:grid-cols-2'
                        : undefined
                }
            >
            <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 delay-75 duration-500">
                <div className="mb-3 flex items-baseline justify-between">
                    <Eyebrow>By project</Eyebrow>
                    <div className="text-[12.5px] tabular-nums text-muted-foreground/70">
                        {rep.projects.length}{' '}
                        {rep.projects.length === 1 ? 'project' : 'projects'} ·{' '}
                        {formatTotal(rep.projectTotalMs)}
                    </div>
                </div>
                {rep.projects.length === 0 ? (
                    <Empty className="border-none py-8">
                        <EmptyHeader>
                            <EmptyTitle>
                                Nothing tracked this{' '}
                                {period === 'weekly' ? 'week' : 'month'}
                            </EmptyTitle>
                            <EmptyDescription>
                                Track some time and it'll break down here.
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <div className="-mx-2.5 flex flex-col">
                        {rep.projects.map((p) => (
                            <div
                                key={p.name}
                                className="flex items-center gap-3.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-subtle-surface"
                            >
                                <span
                                    className="size-2.5 shrink-0 rounded-full"
                                    style={{ background: p.color }}
                                />
                                <div className="w-32 truncate text-sm font-medium text-foreground">
                                    {p.name}
                                </div>
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                    <div
                                        className="h-full rounded-full transition-[width] duration-500"
                                        style={{
                                            width: `${p.barPct}%`,
                                            background: p.color,
                                        }}
                                    />
                                </div>
                                <div className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
                                    {p.pct}%
                                </div>
                                <div className="w-16 text-right font-mono text-sm font-medium tabular-nums text-day-total-foreground">
                                    {formatTotal(p.ms)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Panel>

            {rep.tasks.length > 0 && (
                <Panel className="animate-in fade-in-0 slide-in-from-bottom-1 delay-100 duration-500">
                    <div className="mb-3 flex items-baseline justify-between">
                        <Eyebrow>Most worked on</Eyebrow>
                        <div className="text-[12.5px] text-muted-foreground/70">
                            top {rep.tasks.length === 1 ? 'task' : 'tasks'}
                        </div>
                    </div>
                    <div className="-mx-2.5 flex flex-col">
                        {rep.tasks.map((t) => (
                            <div
                                key={t.title}
                                className="flex items-center gap-3.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-subtle-surface"
                            >
                                <span
                                    className="size-2.5 shrink-0 rounded-full"
                                    style={{ background: t.color }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-foreground">
                                        {t.title}
                                    </div>
                                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                        {t.project}
                                        <span className="mx-1.5 opacity-40">·</span>
                                        {t.sessions}{' '}
                                        {t.sessions === 1 ? 'session' : 'sessions'}
                                    </div>
                                </div>
                                <div className="shrink-0 text-right font-mono text-sm font-medium tabular-nums text-day-total-foreground">
                                    {formatTotal(t.ms)}
                                </div>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}
            </div>
        </div>
    );
}

function StepButton({
    disabled,
    onClick,
    children,
    ...rest
}: React.ComponentProps<'button'>) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'flex size-[30px] items-center justify-center rounded-lg text-muted-foreground transition-colors',
                disabled
                    ? 'cursor-default opacity-25'
                    : 'hover:bg-accent hover:text-foreground',
            )}
            {...rest}
        >
            {children}
        </button>
    );
}

function SummaryStat({ value, label }: { value: string; label: string }) {
    return (
        <div className="text-right">
            <div className="font-mono text-lg font-semibold leading-none tabular-nums text-day-total-foreground">
                {value}
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground/80">{label}</div>
        </div>
    );
}
