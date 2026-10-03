import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { cn } from '@/lib/utils';

// The desktop's starter, reduced to what fits a phone: the question as the
// input, the project underneath. Start lives in the screen's footer, within
// thumb reach, and submitting the keyboard starts too.
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
        <View className="gap-3">
            <View className="flex-row items-center gap-2">
                <View className="size-1.5 rounded-full bg-idle-dot" />
                <Text className="font-mono text-[11px] uppercase tracking-[1.5px] text-ink-faint">Nothing running</Text>
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
                <DropdownMenuTrigger className="flex-row items-center gap-2 self-start rounded-md py-1 pr-2 active:bg-muted">
                    <View className={cn('size-[7px] rounded-[2px]', project ? projectColorClass(project) : 'bg-idle-dot')} />
                    <Text className="font-sans-medium text-sm text-muted-foreground">{project || 'No project'}</Text>
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
    );
}
