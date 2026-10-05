// The running-timer record (neonsync.RunningTimer / running_timers), as the
// phone sees it. The phone keeps no activity log of its own for a running
// timer, so the record is its whole state: start and stop write it, and a
// refresh adopts whatever another device wrote.
import { openTimer, sealTimer, type RunningTimer } from '@/crypto/sync';


export type TimerState = { version: number; timer: RunningTimer | null };

export type Row = { user_id: string; version: number; ciphertext: string; nonce: string };

// The transport, injectable so tests can stand in for the Data API.
export type TimerApi = {
    read(): Promise<Row | null>;
    insert(row: Row): Promise<'ok' | 'conflict'>;
    update(seen: number, row: Row): Promise<'ok' | 'conflict'>;
};

export class TimerConflict extends Error {
    constructor(readonly fresh: TimerState) {
        super('The running timer changed on another device.');
    }
}

export function isRunning(t: RunningTimer | null): t is RunningTimer {
    return t !== null && !t.e && !t.x;
}

export async function readTimer(api: TimerApi, dek: Uint8Array): Promise<TimerState> {
    const row = await api.read();
    return row ? { version: row.version, timer: openTimer(dek, row) } : { version: 0, timer: null };
}

// Writes timer over the record at version seen. On a lost race it throws
// TimerConflict carrying the fresh state to retry against.
export async function writeTimer(api: TimerApi, dek: Uint8Array, owner: string, seen: number, timer: RunningTimer): Promise<TimerState> {
    const row = { user_id: owner, version: seen + 1, ...sealTimer(dek, owner, seen + 1, timer) };
    const result = seen === 0 ? await api.insert(row) : await api.update(seen, row);
    if (result === 'conflict') throw new TimerConflict(await readTimer(api, dek));
    return { version: seen + 1, timer };
}

// Starting stops whatever is running, wherever it runs, so a start that lost
// the race simply goes again on the fresh version: it is still the newest
// event. The device whose timer it replaced closes its copy at this start.
export async function startTimer(api: TimerApi, dek: Uint8Array, owner: string, seen: number, timer: RunningTimer): Promise<TimerState> {
    try {
        return await writeTimer(api, dek, owner, seen, timer);
    } catch (e) {
        if (!(e instanceof TimerConflict)) throw e;
        return writeTimer(api, dek, owner, e.fresh.version, timer);
    }
}

// Stopping only applies to the timer the phone saw running; if another device
// replaced or stopped it first, the fresh state stands.
export async function stopTimer(api: TimerApi, dek: Uint8Array, owner: string, state: TimerState, end: Date): Promise<TimerState> {
    if (!isRunning(state.timer)) return state;
    try {
        return await writeTimer(api, dek, owner, state.version, { ...state.timer, e: end.toISOString() });
    } catch (e) {
        if (!(e instanceof TimerConflict)) throw e;
        const fresh = e.fresh;
        if (isRunning(fresh.timer) && fresh.timer.s === state.timer.s) {
            return writeTimer(api, dek, owner, fresh.version, { ...fresh.timer, e: end.toISOString() });
        }
        return fresh;
    }
}
