import { useMemo, useState } from 'react';
import { Search, Share2 } from 'lucide-react';

import type { Activity } from '@/types';
import { formatTotal, groupByLocalDate, totalDuration } from '@/lib/time';
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

export function HistoryView({
    activities,
    projects,
    removingKeys,
    onUpdate,
    onRemove,
    onResume,
    onAddPast,
    onOpenSharing,
}: {
    activities: Activity[];
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

    const finished = useMemo(
        () => activities.filter((a) => a.end_time),
        [activities],
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
                (a.project ?? '').toLowerCase().includes(q),
        );
    }, [finished, projectFilter, query]);

    const groups = useMemo(() => groupByLocalDate(filtered, true), [filtered]);
    const filteredTotal = useMemo(() => totalDuration(filtered), [filtered]);

    return (
        <div className="flex flex-col gap-6">
            <InputGroup>
                <InputGroupAddon align="inline-start">
                    <Search className="opacity-50" />
                </InputGroupAddon>
                <InputGroupInput
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search description or project"
                    autoComplete="off"
                    spellCheck={false}
                    className="placeholder:select-none"
                />
                <InputGroupAddon align="inline-end">
                    <span className="text-xs tabular-nums text-muted-foreground">
                        {query
                            ? filtered.length === 0
                                ? 'No matches'
                                : `${filtered.length} · ${formatTotal(filteredTotal)}`
                            : `${finished.length} ${
                                  finished.length === 1 ? 'activity' : 'activities'
                              }`}
                    </span>
                </InputGroupAddon>
            </InputGroup>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant={projectFilter === '' ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setProjectFilter('')}
                >
                    All
                </Button>
                {projects.map((p) => (
                    <Button
                        key={p}
                        type="button"
                        variant={projectFilter === p ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setProjectFilter(p)}
                    >
                        {p}
                    </Button>
                ))}
                <div className="flex-1" />
                <span className="text-xs tabular-nums text-muted-foreground">
                    {filtered.length} {filtered.length === 1 ? 'activity' : 'activities'}
                </span>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenSharing(projectFilter || undefined)}
                >
                    <Share2 data-icon="inline-start" />
                    Share this view
                </Button>
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
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                            onResume={onResume}
                        />
                    ))}
                </div>
            )}

            <AddPastButton projects={projects} onAddPast={onAddPast} />
        </div>
    );
}
