import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { formatTotal } from '@/lib/time';

// Today's tracked time against the daily goal (the desktop's TodayGoal), in
// its compact three-across form.
export function TodayGoal({ totalMs, goalMinutes }: { totalMs: number; goalMinutes: number }) {
    const goalMs = goalMinutes * 60_000;
    const pct = goalMs > 0 ? Math.round((totalMs / goalMs) * 100) : 0;
    const remainingMs = Math.max(0, goalMs - totalMs);
    return (
        <View accessibilityLabel="Today's progress" className="flex-row gap-px overflow-hidden rounded-[14px] border border-border bg-border">
            <Cell label="Today" value={formatTotal(totalMs)} />
            <Cell label={`Of ${formatTotal(goalMs)} goal`} value={`${pct}%`}>
                <Progress pct={Math.min(100, pct)} />
            </Cell>
            <Cell label="Remaining" value={remainingMs === 0 ? 'Goal met' : formatTotal(remainingMs)} />
        </View>
    );
}

// The desktop's transition-[width] duration-500 ease-out.
function Progress({ pct }: { pct: number }) {
    const width = useSharedValue(0);
    useEffect(() => {
        width.value = withTiming(pct, { duration: 500, easing: Easing.out(Easing.ease) });
    }, [pct, width]);
    const style = useAnimatedStyle(() => ({ width: `${width.value}%` }));
    return (
        <View className="mt-2 h-1 overflow-hidden rounded-[2px] bg-navigation">
            <Animated.View style={[{ height: '100%' }, style]}>
                <View className="h-full bg-goal-accent" />
            </Animated.View>
        </View>
    );
}

function Cell({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
    return (
        <View className="flex-1 gap-1.5 bg-card px-4 py-3.5">
            <Text numberOfLines={1} className="font-mono text-[11px] uppercase tracking-[1.4px] text-navigation-muted-foreground">
                {label}
            </Text>
            <Text numberOfLines={1} className="font-sans-semibold text-xl tracking-[-0.4px]" style={{ fontVariant: ['tabular-nums'] }}>
                {value}
            </Text>
            {children}
        </View>
    );
}
