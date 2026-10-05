import { FileText, X } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Animated, { withTiming, type EntryExitAnimationFunction } from 'react-native-reanimated';

import { TimeField } from '@/components/TimeField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { EASE_OUT, enter } from '@/lib/motion';
import { cn } from '@/lib/utils';

// The desktop's fade-in-0 slide-in-from-left-1 duration-200.
const enterFromLeft = (() => {
    'worklet';
    const t = { duration: 200, easing: EASE_OUT };
    return {
        initialValues: { opacity: 0, transform: [{ translateX: -4 }] },
        animations: { opacity: withTiming(1, t), transform: [{ translateX: withTiming(0, t) }] },
    };
}) satisfies EntryExitAnimationFunction;

export type StarterDraft = { description: string; project: string; notes: string; startAt: string | null };

// The desktop's starter card, reduced to what fits a phone: the question as
// the input, then the project, notes and "started earlier" controls. Start
// lives in the screen's footer, within thumb reach, and submitting the
// keyboard starts too.
export function Starter({
    draft,
    projects,
    onChange,
    onSubmit,
}: {
    draft: StarterDraft;
    projects: string[];
    onChange: (patch: Partial<StarterDraft>) => void;
    onSubmit: () => void;
}) {
    const [focused, setFocused] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    const { description, project, notes, startAt } = draft;
    return (
        <Animated.View entering={enter({ dy: -8, scale: 0.95, duration: 400 })}>
            <View className="gap-3.5 rounded-2xl border border-border bg-card px-5 pb-3 pt-5">
                <View className="flex-row items-center gap-2.5">
                    <View className="size-1.5 rounded-full bg-idle-dot" />
                    <Text className="font-mono text-xs uppercase tracking-[1.6px] text-ink-faint">Nothing running</Text>
                </View>
                <TextInput
                    value={description}
                    onChangeText={(d) => onChange({ description: d })}
                    onSubmitEditing={onSubmit}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    placeholder="What are you working on?"
                    returnKeyType="go"
                    submitBehavior="blurAndSubmit"
                    multiline
                    accessibilityLabel="What are you working on?"
                    className={cn(
                        'p-0 font-sans-semibold text-[28px] leading-[34px] tracking-[-0.5px] text-foreground placeholder:text-muted-foreground/70',
                        focused && 'placeholder:text-muted-foreground/45',
                    )}
                />
                <View className="-ml-2 flex-row flex-wrap items-center gap-x-1">
                    <DropdownMenu>
                        <DropdownMenuTrigger className="flex-row items-center gap-2 rounded-lg px-2 py-2 active:bg-muted">
                            <View className={cn('size-2 rounded-[2px]', project ? projectColorClass(project) : 'bg-idle-dot')} />
                            <Text className="font-sans-medium text-[15px] text-muted-foreground">{project || 'No project'}</Text>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-56">
                            {['', ...projects].map((p) => (
                                <DropdownMenuItem key={p || '\0none'} onPress={() => onChange({ project: p })}>
                                    <View className={cn('size-[7px] rounded-[2px]', p ? projectColorClass(p) : 'bg-idle-dot')} />
                                    <Text className={cn(p === project && 'font-sans-semibold')}>{p || 'No project'}</Text>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Pressable onPress={() => setNotesOpen(true)} accessibilityRole="button" className="flex-row items-center gap-1.5 rounded-lg px-2 py-2 active:bg-muted">
                        <Icon as={FileText} className="size-4 text-muted-foreground" />
                        <Text className="text-[15px] text-muted-foreground">{notes ? 'Edit notes' : 'Add notes'}</Text>
                    </Pressable>
                    {startAt === null ? (
                        <Pressable
                            onPress={() => onChange({ startAt: formatClockNow() })}
                            accessibilityRole="button"
                            className="rounded-lg px-2 py-2 active:bg-muted"
                        >
                            <Text className="text-[15px] text-muted-foreground">Started earlier…</Text>
                        </Pressable>
                    ) : (
                        <Animated.View entering={enterFromLeft}>
                            <View className="flex-row items-center gap-2 px-2">
                                <Text className="text-[15px] text-muted-foreground">started at</Text>
                                <TimeField label="Started at" value={startAt} onChange={(t) => onChange({ startAt: t })} className="h-9 w-[72px] items-center px-2" openOnMount />
                                <Pressable onPress={() => onChange({ startAt: null })} accessibilityLabel="Clear start time" hitSlop={8}>
                                    <Icon as={X} className="size-4 text-muted-foreground" />
                                </Pressable>
                            </View>
                        </Animated.View>
                    )}
                </View>
            </View>
            <Dialog open={notesOpen} onOpenChange={setNotesOpen}>
                <DialogContent className="w-[92vw] max-w-md">
                    <DialogHeader>
                        <DialogTitle>Activity notes</DialogTitle>
                        <DialogDescription>These notes will be included when you start the activity.</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={notes}
                        onChangeText={(n) => onChange({ notes: n })}
                        placeholder="Notes, links, or next steps"
                        multiline
                        textAlignVertical="top"
                        autoFocus
                        className="h-48 py-3 leading-6"
                    />
                    <DialogFooter>
                        <Button onPress={() => setNotesOpen(false)}>
                            <Text>Done</Text>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Animated.View>
    );
}

function formatClockNow() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
