import * as Haptics from 'expo-haptics';
import { Pencil } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { EditActivityDialog } from '@/components/EditActivityDialog';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { EASE_OUT, enter, LivePulse } from '@/lib/motion';
import { formatClock, formatStopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

const STOP_ANIM_MS = 380;
const tabular = { fontVariant: ['tabular-nums' as const] };

// The desktop's running card (NowRunning.tsx) in its compact, stacked form:
// inverted against the page so the one thing that is live reads first. It
// enters with the desktop's thunk and plays its exit before the stop lands.
export function NowRunning({
    description,
    project,
    start,
    projects,
    onStop,
    onEdit,
}: {
    description: string;
    project: string;
    start: Date;
    projects: string[];
    onStop: () => void;
    onEdit: (description: string, project: string) => Promise<void> | void;
}) {
    const now = useNow();
    const [editing, setEditing] = useState(false);
    const leaving = useSharedValue(0);
    const exitStyle = useAnimatedStyle(() => ({
        opacity: 1 - leaving.value,
        transform: [{ translateY: 8 * leaving.value }, { scale: 1 - 0.05 * leaving.value }],
    }));
    const stopping = useSharedValue(false);

    const stop = () => {
        if (stopping.value) return;
        stopping.value = true;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        leaving.value = withTiming(1, { duration: STOP_ANIM_MS, easing: EASE_OUT });
        setTimeout(onStop, STOP_ANIM_MS);
    };

    return (
        <Animated.View entering={enter({ dy: 24, scale: 0.95, duration: 520 })}>
            <Animated.View style={exitStyle}>
                <View accessibilityLabel="Currently running" className="gap-5 rounded-2xl bg-running-card px-5 pb-5 pt-[22px]">
                    <View className="gap-2.5">
                        <View className="flex-row items-center gap-2.5">
                            <LivePulse className="bg-live-dot-hero" />
                            <Text className="font-mono text-xs uppercase tracking-[1.6px] text-running-card-faint">
                                Running since {formatClock(start)}
                            </Text>
                        </View>
                        <Text numberOfLines={3} className="font-sans-semibold text-[28px] leading-[34px] tracking-[-0.6px] text-running-card-foreground">
                            {description || 'No description'}
                        </Text>
                        <View className="flex-row items-center gap-2">
                            <View className={cn('size-2 rounded-[2px]', projectColorClass(project))} />
                            <Text numberOfLines={1} className="font-sans-medium text-[15px] text-running-card-muted">
                                {project || 'No project'}
                            </Text>
                        </View>
                    </View>
                    <View className="flex-row items-center border-t border-running-card-faint/20 pt-4">
                        <Text accessibilityLiveRegion="polite" className="mr-auto font-mono-medium text-[34px] tracking-[-0.6px] text-running-card-foreground" style={tabular}>
                            {formatStopwatch(now - start.getTime())}
                        </Text>
                        <Pressable
                            onPress={() => setEditing(true)}
                            accessibilityRole="button"
                            accessibilityLabel="Edit running activity"
                            hitSlop={4}
                            className="mr-1.5 size-11 items-center justify-center rounded-xl active:bg-running-card-foreground/10"
                        >
                            <Icon as={Pencil} className="size-[18px] text-running-card-muted" />
                        </Pressable>
                        <Pressable
                            onPress={stop}
                            accessibilityRole="button"
                            className="h-12 flex-row items-center gap-2.5 rounded-xl bg-running-stop px-5 active:scale-95"
                        >
                            <View className="size-2.5 rounded-[2px] bg-running-stop-glyph" />
                            <Text className="font-sans-semibold text-base text-running-stop-foreground">Stop</Text>
                        </Pressable>
                    </View>
                </View>
            </Animated.View>
            <EditActivityDialog
                open={editing}
                onOpenChange={setEditing}
                subtitle={`Started ${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} — still running.`}
                initial={{ description, project }}
                projects={projects}
                onSave={(e) => onEdit(e.description, e.project)}
            />
        </Animated.View>
    );
}
