// The desktop's motion (cmd/tock-desktop/frontend/src/lib/motion.ts and the
// tw-animate-css entrances it pairs with), in Reanimated. Reanimated honours
// the system's reduce-motion setting by default.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming,
    type EntryExitAnimationFunction,
} from 'react-native-reanimated';

import { cn } from '@/lib/utils';

export const EASE_THUNK = Easing.bezier(0.34, 1.45, 0.55, 1);
export const EASE_OUT = Easing.bezier(0.4, 0, 1, 1);
export const EASE_SIZE = Easing.bezier(0.16, 1, 0.3, 1);

// animate-in fade-in-0 zoom-in-{scale} slide-in-from-{dy}: dy > 0 rises from
// below, dy < 0 drops from above.
export function enter({ dy = 0, scale = 1, duration = 300, easing = EASE_THUNK } = {}): EntryExitAnimationFunction {
    return () => {
        'worklet';
        const t = { duration, easing };
        return {
            initialValues: { opacity: 0, transform: [{ translateY: dy }, { scale }] },
            animations: { opacity: withTiming(1, t), transform: [{ translateY: withTiming(0, t) }, { scale: withTiming(1, t) }] },
        };
    };
}

// The running dot's live-pulse: 1.8s, fading to 35% and shrinking to 82%.
export function LivePulse({ className }: { className?: string }) {
    const p = useSharedValue(0);
    useEffect(() => {
        const half = { duration: 900, easing: Easing.inOut(Easing.ease) };
        p.value = withRepeat(withSequence(withTiming(1, half), withTiming(0, half)), -1);
    }, [p]);
    const style = useAnimatedStyle(() => ({ opacity: 1 - 0.65 * p.value, transform: [{ scale: 1 - 0.18 * p.value }] }));
    // Animated views carry only motion; classes go on a plain view inside.
    return (
        <Animated.View style={style}>
            <View className={cn('size-1.5 rounded-full', className)} />
        </Animated.View>
    );
}
