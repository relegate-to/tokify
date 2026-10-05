import { useRef } from 'react';
import type { GestureResponderEvent } from 'react-native';

const SLOP = 10;
// How long after the pager settles a press still counts as part of the swipe.
const SETTLE_MS = 250;

let paging = false;
let settledAt = 0;

// The pager reports its scroll state here (onPageScrollStateChanged).
export function pagerState(state: 'idle' | 'dragging' | 'settling') {
    paging = state !== 'idle';
    if (!paging) settledAt = Date.now();
}

// Android's native pager does not always cancel a press it takes over, so a
// swipe between pages that starts on a row would also tap it, and the press's
// own coordinates can be stale by then. Rows spread these handlers onto their
// Pressable to ignore any press whose finger travelled or that landed while
// the pager was moving.
export function useTap(onTap: () => void) {
    const origin = useRef({ x: 0, y: 0 });
    return {
        onPressIn: (e: GestureResponderEvent) => {
            origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        },
        onPress: (e: GestureResponderEvent) => {
            const dx = Math.abs(e.nativeEvent.pageX - origin.current.x);
            const dy = Math.abs(e.nativeEvent.pageY - origin.current.y);
            if (paging || Date.now() - settledAt < SETTLE_MS) return;
            if (dx < SLOP && dy < SLOP) onTap();
        },
    };
}
