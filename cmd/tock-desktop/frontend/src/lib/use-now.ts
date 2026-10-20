import { useSyncExternalStore } from 'react';

// One clock for every live readout. Each component used to run its own
// interval, so the masthead, the hero stopwatch and the day total re-rendered on
// separate beats — several commits a second, and readouts that turned over at
// visibly different moments. A single timer aligned to the wall-clock second
// updates them together in one commit, and sleeps while the window is hidden.
const TICK_MS = 1_000;

let now = Date.now();
let timer: number | null = null;
const listeners = new Set<() => void>();

function tick() {
    now = Date.now();
    listeners.forEach((listener) => listener());
}

function start() {
    if (timer !== null || document.visibilityState === 'hidden') return;
    const next = () => {
        tick();
        timer = window.setTimeout(next, TICK_MS - (Date.now() % TICK_MS));
    };
    timer = window.setTimeout(next, TICK_MS - (Date.now() % TICK_MS));
    tick();
}

function stop() {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
}

function onVisibility() {
    if (document.visibilityState === 'hidden') stop();
    else start();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        document.addEventListener('visibilitychange', onVisibility);
        start();
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            document.removeEventListener('visibilitychange', onVisibility);
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
