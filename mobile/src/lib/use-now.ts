import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

// One clock for every live readout, as on the desktop. Each caller used to run
// its own timer, so the masthead, the stopwatch and today's total re-rendered on
// separate beats. A single timer aligned to the wall-clock second updates them
// together, and sleeps while the app is in the background.
const TICK_MS = 1000;

let now = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
let appState: NativeEventSubscription | null = null;
const listeners = new Set<() => void>();

function tick() {
    now = Date.now();
    listeners.forEach((listener) => listener());
}

function start() {
    if (timer !== null || AppState.currentState === 'background') return;
    const next = () => {
        tick();
        timer = setTimeout(next, TICK_MS - (Date.now() % TICK_MS));
    };
    timer = setTimeout(next, TICK_MS - (Date.now() % TICK_MS));
    tick();
}

function stop() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        appState = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
        start();
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            appState?.remove();
            appState = null;
            stop();
        }
    };
}

const subscribeNever = () => () => {};

// While the clock sleeps, `now` is stale; read the real time instead.
const current = () => (timer === null ? Date.now() : now);

// The time, rounded down to a whole `stepMs` counted from `anchorMs`. A readout
// that only shows minutes passes a minute step anchored at its activity's start,
// so it re-renders once when the minute turns over instead of every second.
export function useNow(enabled = true, stepMs = TICK_MS, anchorMs = 0): number {
    return useSyncExternalStore(enabled ? subscribe : subscribeNever, () => {
        const t = current();
        return t - ((((t - anchorMs) % stepMs) + stepMs) % stepMs);
    });
}
