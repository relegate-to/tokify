import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { cn } from '@/lib/utils';

export type ActivityEdit = { description: string; project: string; start?: string; end?: string };

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
    subtitle,
    initial,
    projects,
    onSave,
    onDelete,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    subtitle: string;
    initial: ActivityEdit;
    projects: string[];
    onSave: (edit: ActivityEdit) => Promise<void> | void;
    onDelete?: () => Promise<void> | void;
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
            for (const t of [edit.start, edit.end]) {
                const m = t === undefined ? null : HHMM.exec(t);
                if (t !== undefined && (!m || Number(m[1]) > 23 || Number(m[2]) > 59)) throw new Error('Times must be HH:MM.');
            }
            if (edit.start !== undefined && edit.end !== undefined && normalizeClock(edit.end) <= normalizeClock(edit.start)) {
                throw new Error('End must be after start.');
            }
            await onSave({
                description: edit.description.trim(),
                project: edit.project.trim(),
                start: edit.start === undefined ? undefined : normalizeClock(edit.start),
                end: edit.end === undefined ? undefined : normalizeClock(edit.end),
            });
        });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>Edit activity</DialogTitle>
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
                    {edit.start !== undefined ? (
                        <View className="flex-row gap-2">
                            <Field label="Start" className="flex-1">
                                <Input value={edit.start} onChangeText={(start) => set({ start })} placeholder="HH:MM" keyboardType="numbers-and-punctuation" />
                            </Field>
                            {edit.end !== undefined ? (
                                <Field label="End" className="flex-1">
                                    <Input value={edit.end} onChangeText={(end) => set({ end })} placeholder="HH:MM" keyboardType="numbers-and-punctuation" />
                                </Field>
                            ) : null}
                        </View>
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
                        <Text>Save changes</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
    return (
        <View className={cn('gap-1.5', className)}>
            <Text className="text-xs text-muted-foreground">{label}</Text>
            {children}
        </View>
    );
}
