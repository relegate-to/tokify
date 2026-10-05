import * as Haptics from 'expo-haptics';
import { ListChecks, Pencil, RotateCcw, Trash2 } from 'lucide-react-native';
import { useMemo, type ComponentProps, type ReactNode } from 'react';

import { EditActivityDialog, type ActivityEdit } from '@/components/EditActivityDialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useEntries } from '@/lib/entries';
import { useResume } from '@/lib/resume';
import { useSession } from '@/lib/session';
import { parseSyncTime } from '@/lib/time';
import { dataToken } from '@/sync/account';
import { deleteEntries, editEntry, type Entry } from '@/sync/entries';

// What both Jump back in and the Log can do to a tracked activity, as the
// desktop's ActivityRow offers in both its variants.
export function useEntryActions() {
    const { account } = useSession();
    const { reload } = useEntries();
    const resume = useResume();
    return {
        resume: (e: Entry) => resume({ description: e.description, project: e.project }),
        save: async (e: Entry, edit: ActivityEdit) => {
            if (!account) return;
            await editEntry(await dataToken(), account.dek, account.user.id, e, {
                description: edit.description,
                project: edit.project,
                start: `${e.start.slice(0, 10)} ${edit.start}`,
                end: `${e.end.slice(0, 10)} ${edit.end}`,
            });
            await reload();
        },
        remove: async (e: Entry) => {
            await deleteEntries(await dataToken(), [e.id]);
            await reload();
        },
    };
}

// A row that taps for its own action and long-presses for the rest: the
// phone's stand-in for the desktop's context menu. Rows don't swipe, since a
// sideways swipe already moves between pages.
export function EntryMenu({
    entry,
    onEdit,
    onSelect,
    children,
    ...trigger
}: { entry: Entry; onEdit: () => void; onSelect?: () => void; children: ReactNode } & Omit<ComponentProps<typeof ContextMenuTrigger>, 'children'>) {
    const { resume, remove } = useEntryActions();
    return (
        <ContextMenu>
            <ContextMenuTrigger {...trigger} onLongPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)}>
                {children}
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-48">
                <ContextMenuItem onPress={() => resume(entry)}>
                    <Icon as={RotateCcw} className="size-4 text-foreground opacity-70" />
                    <Text>Resume</Text>
                </ContextMenuItem>
                <ContextMenuItem onPress={onEdit}>
                    <Icon as={Pencil} className="size-4 text-foreground opacity-70" />
                    <Text>Edit…</Text>
                </ContextMenuItem>
                {onSelect ? (
                    <ContextMenuItem onPress={onSelect}>
                        <Icon as={ListChecks} className="size-4 text-foreground opacity-70" />
                        <Text>Select</Text>
                    </ContextMenuItem>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem onPress={() => remove(entry)}>
                    <Icon as={Trash2} className="size-4 text-destructive opacity-70" />
                    <Text className="text-destructive">Delete</Text>
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

export function EntryEditor({ entry, onClose }: { entry: Entry; onClose: () => void }) {
    const { resume, save, remove } = useEntryActions();
    const { entries } = useEntries();
    const projects = useMemo(() => [...new Set((entries ?? []).map((e) => e.project).filter(Boolean))], [entries]);
    return (
        <EditActivityDialog
            open
            onOpenChange={(open) => !open && onClose()}
            subtitle={`Tracked ${parseSyncTime(entry.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}.`}
            initial={{ description: entry.description, project: entry.project, start: entry.start.slice(11), end: entry.end.slice(11) }}
            projects={projects}
            onSave={(edit) => save(entry, edit)}
            onDelete={() => remove(entry)}
            onResume={() => {
                // Closed first, so a switch prompt isn't hidden behind it.
                onClose();
                resume(entry);
            }}
        />
    );
}
