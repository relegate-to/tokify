import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, makeMutable, withRepeat, withTiming, useAnimatedStyle } from 'react-native-reanimated';

import { cn } from '@/lib/utils';

// shadcn's Skeleton: a muted block pulsing like animate-pulse (2s, fading to
// half). One clock drives every block so a page of them breathes together.
const pulse = makeMutable(0);
let started = false;

// style places the block (flex, width) in its parent; className draws it.
function Skeleton({ className, style: place }: { className?: string; style?: StyleProp<ViewStyle> }) {
    useEffect(() => {
        if (started) return;
        started = true;
        pulse.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }), -1, true);
    }, []);
    const style = useAnimatedStyle(() => ({ opacity: 1 - 0.5 * pulse.value }));
    // Animated views carry only motion; classes go on a plain view inside.
    return (
        <Animated.View style={[place, style]}>
            <View className={cn('rounded-md bg-muted', className)} />
        </Animated.View>
    );
}

export { Skeleton };
