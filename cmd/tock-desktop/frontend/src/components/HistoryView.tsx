import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Search, Share2, Users } from 'lucide-react';

import type { Activity, ActivityItem } from '@/types';
import { groupByLocalDate } from '@/lib/time';
import { durationMs } from '@/lib/summary';
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';

// Sentinel author for the user filter that matches the caller's own local
// entries (which carry no `shared` author). A shared authorName can never
// collide with a NUL-prefixed string.
const SELF_USER = '\u0000self';

// How many project pills the filter row shows. Matches what Projects() used to
// hand it, so the row keeps its usual size.
const PROJECT_FILTER_LIMIT = 8;

function userKey(a: ActivityItem) {
    return a.shared?.authorName ?? SELF_USER;
}

function UserOption({
    selected,
    label,
    onSelect,
}: {
    selected: boolean;
    label: string;
    onSelect: () => void;
}) {
    return (
        <DropdownMenuItem onSelect={onSelect}>
            <Check className={selected ? 'opacity-100' : 'opacity-0'} />
            {label}
        </DropdownMenuItem>
    );
}

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
    onUpdate: (orig: Activity, description: string, project: string, notes: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume: (orig: Activity) => void;
    onAddPast: (description: string, project: string, notes: string, startISO: string, endISO: string) => void;
    onOpenSharing: (project?: string) => void;
}) {
    const [query, setQuery] = useState('');
    const [projectFilter, setProjectFilter] = useState('');
    const [userFilter, setUserFilter] = useState('');
    // Radix opens on pointerdown, which Swiper swallows inside a slide, so the
    // menu is controlled and opened by the trigger's click (clicks still fire).
    const [userMenuOpen, setUserMenuOpen] = useState(false);

    // Distinct authors who shared entries into the caller's teams. Drives the
    // user filter; when empty the caller is the only "user" and the control hides.
    const authors = useMemo(() => {
        const names = new Set<string>();
        for (const a of sharedActivities) {
            if (a.shared?.authorName) names.add(a.shared.authorName);
        }
        return [...names].sort((x, y) => x.localeCompare(y));
    }, [sharedActivities]);

    // Drop a stale author filter if that author stops sharing, so the hidden
    // dropdown can't leave an unclearable filter applied.
    useEffect(() => {
        if (
            userFilter &&
            userFilter !== SELF_USER &&
            !authors.includes(userFilter)
        ) {
            setUserFilter('');
        }
    }, [authors, userFilter]);

    const q = query.trim().toLowerCase();
    const matches = useCallback(
        (a: ActivityItem) => {
            if (projectFilter && (a.project ?? '') !== projectFilter) return false;
            if (userFilter && userKey(a) !== userFilter) return false;
            if (!q) return true;
            return (
                (a.description ?? '').toLowerCase().includes(q) ||
                (a.project ?? '').toLowerCase().includes(q) ||
                (a.shared?.authorName ?? '').toLowerCase().includes(q)
            );
        },
        [projectFilter, userFilter, q],
    );

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
    const filtered = useMemo(() => finished.filter(matches), [finished, matches]);

    // The contribution graph reflects the same filters as the list. It draws
    // from the full-year local history (rather than the recent-limited list)
    // merged with shared entries so the user filter reaches shared authors.
    const graphFiltered = useMemo<ActivityItem[]>(
        () =>
            [
                ...graphActivities,
                ...sharedActivities.filter((a) => a.end_time),
            ].filter(matches),
        [graphActivities, sharedActivities, matches],
    );

    // The filter row builds its own project list rather than using the `projects`
    // prop. That one is ordered most-recently-tracked first for the Starter and
    // edit pickers, so deleting an entry reshuffles it, and it can only change
    // when a backend refresh lands — the row reordered itself a beat after the
    // list had already moved. Ranking by tracked time picks a set a single
    // delete won't disturb, and rendering it alphabetically means a delete can
    // drop a pill but never move one.
    const filterProjects = useMemo(() => {
        const totals = new Map<string, number>();
        for (const a of finished) {
            const p = (a.project ?? '').trim();
            if (!p) continue;
            totals.set(p, (totals.get(p) ?? 0) + durationMs(a));
        }
        const top = [...totals.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, PROJECT_FILTER_LIMIT)
            .map(([p]) => p);
        // A project filtered on from outside the top set still needs its pill,
        // otherwise the active filter has no visible control.
        if (projectFilter && !top.includes(projectFilter)) top.push(projectFilter);
        return top.sort((x, y) => x.localeCompare(y));
    }, [finished, projectFilter]);

    const groups = useMemo(() => groupByLocalDate(filtered, true), [filtered]);

    const userLabel =
        userFilter === ''
            ? 'Everyone'
            : userFilter === SELF_USER
              ? 'You'
              : userFilter;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
                <ContributionGraph activities={graphFiltered} />

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
                    {filterProjects.map((p) => (
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
                        {authors.length > 0 && (
                            <>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            type="button"
                                            variant={userFilter ? 'default' : 'outline'}
                                            size="sm"
                                            className="rounded-full px-3"
                                        >
                                            <Users data-icon="inline-start" />
                                            {userLabel}
                                            <ChevronDown data-icon="inline-end" className="opacity-60" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        {[
                                            { key: '', label: 'Everyone' },
                                            { key: SELF_USER, label: 'You' },
                                        ].map((opt) => (
                                            <UserOption
                                                key={opt.key || 'everyone'}
                                                selected={userFilter === opt.key}
                                                label={opt.label}
                                                onSelect={() => setUserFilter(opt.key)}
                                            />
                                        ))}
                                        <DropdownMenuSeparator />
                                        {authors.map((name) => (
                                            <UserOption
                                                key={name}
                                                selected={userFilter === name}
                                                label={name}
                                                onSelect={() => setUserFilter(name)}
                                            />
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                                <Separator orientation="vertical" className="mx-1 h-4" />
                            </>
                        )}
                        <AddPastButton
                            projects={projects}
                            onAddPast={onAddPast}
                        />
                        {/*<Button
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
                        </Button>*/}
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
