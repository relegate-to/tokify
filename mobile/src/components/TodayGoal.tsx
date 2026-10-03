import { View } from 'react-native';

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
                <View className="mt-1.5 h-[3px] overflow-hidden rounded-[2px] bg-navigation">
                    <View className="h-full bg-goal-accent" style={{ width: `${Math.min(100, pct)}%` }} />
                </View>
            </Cell>
            <Cell label="Remaining" value={remainingMs === 0 ? 'Goal met' : formatTotal(remainingMs)} />
        </View>
    );
}

function Cell({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
    return (
        <View className="flex-1 gap-[5px] bg-card px-3.5 py-3">
            <Text numberOfLines={1} className="font-mono text-[10px] uppercase tracking-[1.4px] text-navigation-muted-foreground">
                {label}
            </Text>
            <Text numberOfLines={1} className="font-sans-semibold text-lg tracking-[-0.3px]" style={{ fontVariant: ['tabular-nums'] }}>
                {value}
            </Text>
            {children}
        </View>
    );
}
