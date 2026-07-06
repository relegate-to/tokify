import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

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

export function HistoryView({
    activities,
    projects,
    removingKeys,
    onUpdate,
    onRemove,
    onResume,
    onAddPast,
}: {
    activities: Activity[];
    projects: string[];
    removingKeys: Set<string>;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume: (orig: Activity) => void;
    onAddPast: (description: string, project: string, startISO: string, endISO: string) => void;
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
