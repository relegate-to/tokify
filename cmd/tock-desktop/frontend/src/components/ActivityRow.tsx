import { useState } from 'react';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';

import type { Activity, ActivityItem } from '@/types';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { formatClock, formatDuration, formatTotal } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { Button } from '@/components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ProjectTag } from '@/components/ProjectTag';
import { SharedAuthorBadge } from '@/components/SharedAuthorBadge';
import { EditActivityDialog } from '@/components/EditActivityDialog';

const ROW_HEIGHT = 'h-11';
const ROW_GRID =
    'grid grid-cols-[68px_136px_minmax(0,1fr)_68px_52px] items-center px-3';

// The Log lists a day in columns you scan top-down; the tracker's recents ledger
// is a denser hairline-ruled list whose whole row starts the task again. Same
// row component either way, so editing, deleting, and resuming behave alike.
const LEDGER_ROW_HEIGHT = 'h-[50px]';

export function ActivityRow({
    activity,
    projects,
    isRemoving = false,
    onUpdate,
    onRemove,
    onResume,
    readOnly = false,
    variant = 'log',
}: {
    activity: ActivityItem;
    projects: string[];
    isRemoving?: boolean;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume?: (orig: Activity) => void;
    readOnly?: boolean;
    variant?: 'log' | 'ledger';
}) {
    // A shared entry belongs to another member: always read-only, never editable
    // or removable here, and tagged with the author's avatar badge.
    const shared = activity.shared;
    readOnly = readOnly || !!shared;

    const start = new Date(activity.start_time as any);
    const end = activity.end_time ? new Date(activity.end_time as any) : null;
    const isRunning = !end;
    const now = useNow(isRunning);
    const ms = (end?.getTime() ?? now) - start.getTime();

    const [editOpen, setEditOpen] = useState(false);

    const enterEdit = () => {
        if (!readOnly) setEditOpen(true);
    };

    const isLedger = variant === 'ledger';
    const project = activity.project || '';
    const resumeLabel = activity.description
        ? `Resume ${activity.description}`
        : 'Resume activity';
    const startResume = () => {
        if (!readOnly) onResume?.(activity);
    };

    const ledgerRow = (
        <li
            role={onResume && !readOnly ? 'button' : undefined}
            tabIndex={onResume && !readOnly ? 0 : undefined}
            aria-label={onResume && !readOnly ? resumeLabel : undefined}
            onClick={startResume}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    startResume();
                }
            }}
            className={cn(
                'group/row flex min-h-0 items-center gap-4 overflow-hidden border-t border-border px-1 text-left last:border-b',
                'transition-[height,opacity,background-color] duration-200 ease-out',
                isRemoving
                    ? 'h-0 border-transparent opacity-0'
                    : LEDGER_ROW_HEIGHT,
                !readOnly &&
                    'cursor-pointer hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none',
            )}
        >
            <span
                aria-hidden
                className="size-[7px] shrink-0 rounded-[2px]"
                style={{ backgroundColor: projectColor(project) }}
            />
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                {activity.description || 'No description'}
            </span>
            <span className="hidden max-w-[40%] shrink-0 truncate text-[13px] text-ink-faint sm:block">
                {project || 'No project'}
            </span>
            <span className="w-[72px] shrink-0 text-right font-mono text-[13px] tabular-nums text-secondary-foreground">
                {formatTotal(ms)}
            </span>
            <span className="flex w-6 shrink-0 items-center justify-end">
                {shared ? (
                    <SharedAuthorBadge shared={shared} />
                ) : (
                    !readOnly && (
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(activity);
                            }}
                            className="text-destructive opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                            title="Delete"
                        >
                            <Trash2 />
                        </Button>
                    )
                )}
            </span>
        </li>
    );

    const logRow = (
        <li
            onDoubleClick={enterEdit}
            className={cn(
                'group/row relative min-h-0 overflow-hidden rounded-md border border-transparent',
                'transition-[height,opacity,transform,background-color,border-color] duration-200 ease-out',
                isRemoving ? 'h-0 -translate-x-2 opacity-0' : ROW_HEIGHT,
                ROW_GRID,
                editOpen ? 'border-border bg-muted/40' : 'hover:bg-muted/40',
                !isRemoving &&
                    'animate-in fade-in-0 slide-in-from-top-1 duration-300',
            )}
        >
            <span className="font-mono text-sm tabular-nums text-navigation-muted-foreground">
                {formatClock(start)}
            </span>

            <div className="min-w-0 pr-3">
                {activity.project && (
                    <ProjectTag
                        project={activity.project}
                        team={shared ? true : undefined}
                        className="w-full text-sm"
                    />
                )}
            </div>

            <span
                className={cn(
                    'truncate pr-3 text-sm font-medium',
                    !activity.description && 'text-muted-foreground',
                )}
            >
                {activity.description || 'No description'}
            </span>

            <span
                className={cn(
                    'pr-3.5 text-right font-mono text-sm font-medium tabular-nums',
                    isRunning ? 'text-foreground' : 'text-muted-foreground',
                )}
            >
                {formatDuration(ms)}
            </span>

            <div className="flex items-center justify-end gap-1">
                {shared ? (
                    <SharedAuthorBadge shared={shared} />
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
                                onClick={() => onRemove(activity)}
                                className="text-destructive opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                                title="Delete"
                            >
                                <Trash2 />
                            </Button>
                        </>
                    )
                )}
            </div>
        </li>
    );

    const row = isLedger ? ledgerRow : logRow;

    // Shared rows are display-only: no context menu, no edit surface.
    if (readOnly) return row;

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                    <ContextMenuItem onSelect={() => setEditOpen(true)}>
                        <Pencil className="size-4 opacity-70" />
                        Edit…
                    </ContextMenuItem>
                    {onResume && (
                        <ContextMenuItem onSelect={() => onResume(activity)}>
                            <RotateCcw className="size-4 opacity-70" />
                            Resume
                        </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        className="text-destructive data-[highlighted]:text-destructive"
                        onSelect={() => onRemove(activity)}
                    >
                        <Trash2 className="size-4 opacity-70" />
                        Delete
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
            <EditActivityDialog
                open={editOpen}
                onOpenChange={setEditOpen}
                activity={activity}
                projects={projects}
                onUpdate={onUpdate}
            />
        </>
    );
}
