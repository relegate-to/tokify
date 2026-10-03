import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { cn } from '@/lib/utils';

// The desktop's starter, reduced to what fits a phone: the question as the
// input, the project underneath. Start lives in the screen's footer, within
// thumb reach, and submitting the keyboard starts too.
export function Starter({
    description,
    project,
    onChange,
    onSubmit,
}: {
    description: string;
    project: string;
    onChange: (description: string) => void;
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
            <View className="flex-row items-center gap-2">
                <View className={cn('size-[7px] rounded-[2px]', project ? projectColorClass(project) : 'bg-idle-dot')} />
                <Text className="font-sans-medium text-sm text-muted-foreground">{project || 'No project'}</Text>
            </View>
        </View>
    );
}
