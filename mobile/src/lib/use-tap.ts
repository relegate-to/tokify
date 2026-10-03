import { useRef } from 'react';
import type { GestureResponderEvent } from 'react-native';

const SLOP = 10;

// Android's native pager does not always cancel a press it takes over, so a
// swipe between pages that starts on a row would also tap it. Rows spread these
// handlers onto their Pressable to ignore any press whose finger travelled.
export function useTap(onTap: () => void) {
    const origin = useRef({ x: 0, y: 0 });
    return {
        onPressIn: (e: GestureResponderEvent) => {
            origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        },
        onPress: (e: GestureResponderEvent) => {
            const dx = Math.abs(e.nativeEvent.pageX - origin.current.x);
            const dy = Math.abs(e.nativeEvent.pageY - origin.current.y);
            if (dx < SLOP && dy < SLOP) onTap();
        },
    };
}
