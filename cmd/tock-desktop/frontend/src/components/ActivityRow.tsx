import { useState } from 'react';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';

import type { Activity, ActivityItem } from '@/types';
import { cn } from '@/lib/utils';
import { formatClock, formatDuration } from '@/lib/time';
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

export function ActivityRow({
    activity,
    projects,
    isRemoving = false,
    onUpdate,
    onRemove,
    onResume,
    readOnly = false,
}: {
    activity: ActivityItem;
    projects: string[];
    isRemoving?: boolean;
    onUpdate: (orig: Activity, description: string, project: string, startISO: string, endISO: string) => void;
    onRemove: (orig: Activity) => void;
    onResume?: (orig: Activity) => void;
    readOnly?: boolean;
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

    const row = (
        <li
            onDoubleClick={enterEdit}
            className={cn(
                'group/row relative overflow-hidden rounded-md border border-transparent',
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
