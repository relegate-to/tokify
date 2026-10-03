import { useState } from 'react';
import { TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { enter } from '@/lib/motion';
import { cn } from '@/lib/utils';

// The desktop's starter card, reduced to what fits a phone: the question as
// the input, the project underneath. Start lives in the screen's footer,
// within thumb reach, and submitting the keyboard starts too.
export function Starter({
    description,
    project,
    projects,
    onChange,
    onProject,
    onSubmit,
}: {
    description: string;
    project: string;
    projects: string[];
    onChange: (description: string) => void;
    onProject: (project: string) => void;
    onSubmit: () => void;
}) {
    const [focused, setFocused] = useState(false);
    return (
        <Animated.View entering={enter({ dy: -8, scale: 0.95, duration: 400 })}>
            <View className="gap-3.5 rounded-2xl border border-border bg-card px-5 pb-4 pt-5">
                <View className="flex-row items-center gap-2.5">
                    <View className="size-1.5 rounded-full bg-idle-dot" />
                    <Text className="font-mono text-xs uppercase tracking-[1.6px] text-ink-faint">Nothing running</Text>
                </View>
                <TextInput
                    value={description}
                    onChangeText={onChange}
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
                <DropdownMenu>
                    <DropdownMenuTrigger className="-ml-2 flex-row items-center gap-2 self-start rounded-lg px-2 py-2 active:bg-muted">
                        <View className={cn('size-2 rounded-[2px]', project ? projectColorClass(project) : 'bg-idle-dot')} />
                        <Text className="font-sans-medium text-[15px] text-muted-foreground">{project || 'No project'}</Text>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-56">
                        {['', ...projects].map((p) => (
                            <DropdownMenuItem key={p || '\0none'} onPress={() => onProject(p)}>
                                <View className={cn('size-[7px] rounded-[2px]', p ? projectColorClass(p) : 'bg-idle-dot')} />
                                <Text className={cn(p === project && 'font-sans-semibold')}>{p || 'No project'}</Text>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </View>
        </Animated.View>
    );
}
