import { describe, expect, it } from 'vitest';

import type { RunningTimer } from '@/crypto/sync';

import { isRunning, readTimer, startTimer, stopTimer, type TimerApi, type TimerState } from './timer';

// One shared row with the version rules the schema enforces.
function fakeApi() {
    let row: Parameters<TimerApi['insert']>[0] | null = null;
    const api: TimerApi = {
        read: async () => row,
        insert: async (r) => {
            if (row) return 'conflict';
            row = r;
            return 'ok';
        },
        update: async (seen, r) => {
            if (!row || row.version !== seen) return 'conflict';
            row = r;
            return 'ok';
        },
    };
    return api;
}

const dek = new Uint8Array(32).fill(7);
const timer = (d: string, s: string, dev = 'phone'): RunningTimer => ({ d, p: '', s, dev });

describe('running timer on the phone', () => {
    it('starts, reads back and stops', async () => {
        const api = fakeApi();
        let state = await startTimer(api, dek, 'u', 0, timer('Plan', '2026-10-03T09:00:00.000Z'));
        expect(state.version).toBe(1);
        expect(await readTimer(api, dek)).toEqual(state);

        state = await stopTimer(api, dek, 'u', state, new Date('2026-10-03T10:00:00.000Z'));
        expect(state.version).toBe(2);
        expect(isRunning(state.timer)).toBe(false);
        expect(state.timer?.e).toBe('2026-10-03T10:00:00.000Z');
    });

    it('keeps the desktop start string untouched when stopping', async () => {
        const api = fakeApi();
        const desktop = timer('Desk work', '2026-10-03T10:30:15.123456789+01:00', 'mac');
        const seen = await startTimer(api, dek, 'u', 0, desktop);
        const stopped = await stopTimer(api, dek, 'u', seen, new Date('2026-10-03T10:00:00.000Z'));
        expect(stopped.timer?.s).toBe(desktop.s);
    });

    it('a start that loses the race still wins on the fresh version', async () => {
        const api = fakeApi();
        await startTimer(api, dek, 'u', 0, timer('On the Mac', '2026-10-03T09:00:00.000Z', 'mac'));
        const state = await startTimer(api, dek, 'u', 0, timer('On the phone', '2026-10-03T09:05:00.000Z'));
        expect(state.version).toBe(2);
        expect((await readTimer(api, dek)).timer?.d).toBe('On the phone');
    });

    it('a stop does not override a timer another device started meanwhile', async () => {
        const api = fakeApi();
        const seen: TimerState = await startTimer(api, dek, 'u', 0, timer('Old', '2026-10-03T09:00:00.000Z'));
        await startTimer(api, dek, 'u', seen.version, timer('New on the Mac', '2026-10-03T09:30:00.000Z', 'mac'));
        const after = await stopTimer(api, dek, 'u', seen, new Date('2026-10-03T09:45:00.000Z'));
        expect(after.timer?.d).toBe('New on the Mac');
        expect(isRunning(after.timer)).toBe(true);
    });

    it('a stop that raced an edit of the same timer still stops it', async () => {
        const api = fakeApi();
        const seen = await startTimer(api, dek, 'u', 0, timer('Plan', '2026-10-03T09:00:00.000Z'));
        await startTimer(api, dek, 'u', seen.version, { ...timer('Plan the release', '2026-10-03T09:00:00.000Z'), dev: 'mac' });
        const after = await stopTimer(api, dek, 'u', seen, new Date('2026-10-03T09:45:00.000Z'));
        expect(after.version).toBe(3);
        expect(after.timer?.d).toBe('Plan the release');
        expect(isRunning(after.timer)).toBe(false);
    });
});
