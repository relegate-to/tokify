import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { RotateCcw } from 'lucide-react-native';

import { NotesField } from '@/components/NotesField';
import { DateField, TimeField } from '@/components/TimeField';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { cn } from '@/lib/utils';

// notes appear only for the running timer, whose notes sync; completed
// entries carry none in the sync format.
export type ActivityEdit = { description: string; project: string; notes?: string; date?: string; start?: string; end?: string };

const HHMM = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/;

// "9:05" → "09:05", so times compare and store like the sync format.
export function normalizeClock(t: string) {
    const m = HHMM.exec(t);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
}

// The desktop's EditActivityDialog. Times are HH:MM on the activity's own
// day; a running timer edits only its description and project.
export function EditActivityDialog({
    open,
    onOpenChange,
    title = 'Edit activity',
    saveLabel = 'Save changes',
    subtitle,
    initial,
    projects,
    onSave,
    onDelete,
    onResume,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title?: string;
    saveLabel?: string;
    subtitle: string;
    initial: ActivityEdit;
    projects: string[];
    onSave: (edit: ActivityEdit) => Promise<void> | void;
    onDelete?: () => Promise<void> | void;
    // Starts the activity again as it was, not as edited.
    onResume?: () => Promise<void> | void;
}) {
    const [edit, setEdit] = useState(initial);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (open) {
            setEdit(initial);
            setError('');
        }
        // Reset only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const set = (patch: Partial<ActivityEdit>) => setEdit((e) => ({ ...e, ...patch }));

    const act = async (fn: () => Promise<void> | void) => {
        setBusy(true);
        setError('');
        try {
            await fn();
            onOpenChange(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const save = () =>
        act(async () => {
            if (!edit.description.trim()) throw new Error('Describe what you were working on.');
            if (edit.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(edit.date.trim())) throw new Error('Date must be YYYY-MM-DD.');
            for (const t of [edit.start, edit.end]) {
                const m = t === undefined ? null : HHMM.exec(t);
                if (t !== undefined && (!m || Number(m[1]) > 23 || Number(m[2]) > 59)) throw new Error('Pick a start and an end time.');
            }
            if (edit.start !== undefined && edit.end !== undefined && normalizeClock(edit.end) <= normalizeClock(edit.start)) {
                throw new Error('End must be after start.');
            }
            await onSave({
                description: edit.description.trim(),
                notes: edit.notes,
                project: edit.project.trim(),
                date: edit.date?.trim(),
                start: edit.start === undefined ? undefined : normalizeClock(edit.start),
                end: edit.end === undefined ? undefined : normalizeClock(edit.end),
            });
        });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{subtitle}</DialogDescription>
                </DialogHeader>
                <View className="gap-3">
                    <Field label="Description">
                        <Input value={edit.description} onChangeText={(description) => set({ description })} placeholder="What were you working on?" />
                    </Field>
                    <Field label="Project">
                        <Input value={edit.project} onChangeText={(project) => set({ project })} placeholder="project (optional)" autoCapitalize="none" />
                        {projects.length > 0 ? (
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-1.5 pt-1.5" keyboardShouldPersistTaps="handled">
                                {projects.map((p) => (
                                    <Button key={p} size="sm" variant={p === edit.project ? 'secondary' : 'ghost'} className="h-8 px-2.5" onPress={() => set({ project: p })}>
                                        <View className={cn('size-[7px] rounded-[2px]', projectColorClass(p))} />
                                        <Text className="text-[13px]">{p}</Text>
                                    </Button>
                                ))}
                            </ScrollView>
                        ) : null}
                    </Field>
                    {edit.notes !== undefined ? (
                        <Field label="Notes">
                            <NotesField value={edit.notes} onChange={(notes) => set({ notes })} placeholder="Details, links, or next steps" />
                        </Field>
                    ) : null}
                    {edit.date !== undefined ? (
                        <Field label="Date">
                            <DateField label="Date" value={edit.date} onChange={(date) => set({ date })} />
                        </Field>
                    ) : null}
                    {edit.start !== undefined ? (
                        <View className="flex-row gap-2">
                            <Field label="Start" className="flex-1">
                                <TimeField label="Start" value={edit.start} onChange={(start) => set({ start })} />
                            </Field>
                            {edit.end !== undefined ? (
                                <Field label="End" className="flex-1">
                                    <TimeField label="End" value={edit.end} onChange={(end) => set({ end })} />
                                </Field>
                            ) : null}
                        </View>
                    ) : null}
                    {onResume ? (
                        <Button variant="outline" className="mt-1 h-11 rounded-lg" disabled={busy} onPress={() => act(onResume)}>
                            <Icon as={RotateCcw} className="size-4 text-foreground" />
                            <Text>Resume this activity</Text>
                        </Button>
                    ) : null}
                    {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                </View>
                <DialogFooter className="flex-row items-center">
                    {onDelete ? (
                        <Button variant="ghost" className="mr-auto px-2" disabled={busy} onPress={() => act(onDelete)}>
                            <Text className="text-destructive">Delete</Text>
                        </Button>
                    ) : null}
                    <Button variant="ghost" disabled={busy} onPress={() => onOpenChange(false)}>
                        <Text>Cancel</Text>
                    </Button>
                    <Button disabled={busy} onPress={save}>
                        <Text>{saveLabel}</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
    return (
        <View className={cn('gap-1.5', className)}>
            <Text className="text-[13px] text-muted-foreground">{label}</Text>
            {children}
        </View>
    );
}
