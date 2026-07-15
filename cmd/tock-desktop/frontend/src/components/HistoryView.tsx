import { useMemo, useState } from 'react';
import { Search, Share2 } from 'lucide-react';

import type { Activity, ActivityItem } from '@/types';
import { groupByLocalDate } from '@/lib/time';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@/components/ui/empty';
import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput,
} from '@/components/ui/input-group';
import { DayGroup } from '@/components/DayGroup';
import { AddPastButton } from '@/components/AddPastDialog';
import { Button } from '@/components/ui/button';
import { ContributionGraph } from '@/components/ContributionGraph';
import { Separator } from '@/components/ui/separator';

export function HistoryView({
    activities,
    sharedActivities,
    graphActivities,
    projects,
    removingKeys,
    onUpdate,
    onRemove,
    onResume,
    onAddPast,
    onOpenSharing,
}: {
    activities: Activity[];
    sharedActivities: ActivityItem[];
    graphActivities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume: (orig: Activity) => void;
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
    onOpenSharing: (project?: string) => void;
}) {
    const [query, setQuery] = useState('');
    const [projectFilter, setProjectFilter] = useState('');

    // Local finished activities plus read-only entries other members shared with
    // the caller's teams. Shared rows are display-only (never merged into the
    // local log) but they group and filter alongside local rows.
    const finished = useMemo<ActivityItem[]>(
        () => [
            ...activities.filter((a) => a.end_time),
            ...sharedActivities.filter((a) => a.end_time),
        ],
        [activities, sharedActivities],
    );
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const scoped = projectFilter
            ? finished.filter((a) => (a.project ?? '') === projectFilter)
            : finished;
        if (!q) return scoped;
        return scoped.filter(
            (a) =>
                (a.description ?? '').toLowerCase().includes(q) ||
                (a.project ?? '').toLowerCase().includes(q) ||
                (a.shared?.authorName ?? '').toLowerCase().includes(q),
        );
    }, [finished, projectFilter, query]);

    const groups = useMemo(() => groupByLocalDate(filtered, true), [filtered]);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
                <ContributionGraph activities={graphActivities} />

                <InputGroup className="h-10 rounded-xl border-subtle-surface-border bg-subtle-surface">
                    <InputGroupAddon align="inline-start">
                        <Search className="opacity-50" />
                    </InputGroupAddon>
                    <InputGroupInput
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search description or project"
                        autoComplete="off"
                        spellCheck={false}
                        className="text-sm placeholder:select-none"
                    />
                </InputGroup>

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        variant={projectFilter === '' ? 'default' : 'outline'}
                        size="sm"
                        className="rounded-full px-3"
                        onClick={() => setProjectFilter('')}
                    >
                        All
                    </Button>
                    {projects.map((p) => (
                        <Button
                            key={p}
                            type="button"
                            variant={projectFilter === p ? 'default' : 'outline'}
                            size="sm"
                            className="rounded-full px-3"
                            onClick={() => setProjectFilter(p)}
                        >
                            {p}
                        </Button>
                    ))}
                    <div className="flex-1" />
                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-sm tabular-nums text-muted-foreground">
                            {filtered.length}{' '}
                            {filtered.length === 1 ? 'activity' : 'activities'}
                        </span>
                        <Separator orientation="vertical" className="mx-1 h-4" />
                        <AddPastButton
                            projects={projects}
                            onAddPast={onAddPast}
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="font-normal text-muted-foreground"
                            onClick={() =>
                                onOpenSharing(projectFilter || undefined)
                            }
                        >
                            <Share2 data-icon="inline-start" />
                            Share this view
                        </Button>
                    </div>
                </div>
            </div>

            {groups.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyTitle>
                            {finished.length === 0
                                ? 'No finished activities yet'
                                : 'No matches'}
                        </EmptyTitle>
                        <EmptyDescription>
                            {finished.length === 0
                                ? 'Start tracking from the Now tab.'
                                : 'Try a different search.'}
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <div className="flex flex-col gap-6">
                    {groups.map((g) => (
                        <DayGroup
                            key={g.dateKey}
                            day={g.date}
                            activities={g.items}
                            projects={projects}
                            removingKeys={removingKeys}
                            variant="history"
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                            onResume={onResume}
                        />
                    ))}
                </div>
            )}

        </div>
    );
}
