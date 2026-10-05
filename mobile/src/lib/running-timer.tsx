import * as SecureStore from 'expo-secure-store';
import { randomBytes } from '@noble/hashes/utils.js';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { bytesToHex } from '@/crypto/bytes';
import type { RunningTimer } from '@/crypto/sync';
import { useEntries } from '@/lib/entries';
import { useSession } from '@/lib/session';
import { dataToken } from '@/sync/account';
import { entryFromTimer, flushPending, queueEntry } from '@/sync/entries';
import { isRunning, readTimer, startTimer, stopTimer, TimerConflict, writeTimer, type TimerState } from '@/sync/timer';
import { dataApi, isMissingTable } from '@/sync/timer-api';

const REFRESH_MS = 15_000;
const STATE_KEY = 'timer.state';
const DEVICE_KEY = 'device.id';

const api = dataApi(dataToken);

async function deviceId() {
    let id = await SecureStore.getItemAsync(DEVICE_KEY);
    if (!id) {
        id = bytesToHex(randomBytes(16));
        await SecureStore.setItemAsync(DEVICE_KEY, id);
    }
    return id;
}

// The account's running timer, kept in step with the other devices: refreshed
// on foreground and every 15s while open. Until the server has the
// running_timers table the timer works on this phone alone (localOnly).
function useTimerState() {
    const { account } = useSession();
    const [state, setState] = useState<TimerState>({ version: 0, timer: null });
    const [localOnly, setLocalOnly] = useState(false);
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);
    const stateRef = useRef(state);

    const adopt = useCallback((next: TimerState) => {
        stateRef.current = next;
        setState(next);
        SecureStore.setItemAsync(STATE_KEY, JSON.stringify(next)).catch(() => undefined);
    }, []);

    // Completed activities the phone ended go to the entries table, which
    // works even before the server has running_timers.
    const { reload } = useEntries();
    const flush = useCallback(async () => {
        if (!account) return;
        try {
            if (await flushPending(await dataToken(), account.dek, account.user.id)) await reload();
        } catch {
            // Stays queued for the next refresh.
        }
    }, [account, reload]);

    const refresh = useCallback(async () => {
        flush();
        if (!account || localOnly) return;
        try {
            const fresh = await readTimer(api, account.dek);
            if (fresh.version !== stateRef.current.version) adopt(fresh);
            setError('');
        } catch (e) {
            if (isMissingTable(e)) setLocalOnly(true);
            else setError(e instanceof Error ? e.message : String(e));
        }
    }, [account, localOnly, adopt, flush]);

    useEffect(() => {
        SecureStore.getItemAsync(STATE_KEY)
            .then((cached) => cached && adopt(JSON.parse(cached) as TimerState))
            .finally(() => {
                setLoaded(true);
                refresh();
            });
        let timer = setInterval(refresh, REFRESH_MS);
        const sub = AppState.addEventListener('change', (s) => {
            clearInterval(timer);
            if (s === 'active') {
                refresh();
                timer = setInterval(refresh, REFRESH_MS);
            }
        });
        return () => {
            clearInterval(timer);
            sub.remove();
        };
    }, [refresh, adopt]);

    const run = useCallback(
        async (local: TimerState, remote: () => Promise<TimerState>) => {
            const before = stateRef.current;
            adopt(local);
            if (localOnly) return;
            try {
                adopt(await remote());
                setError('');
            } catch (e) {
                if (isMissingTable(e)) return setLocalOnly(true);
                adopt(before);
                setError(e instanceof Error ? e.message : String(e));
            }
        },
        [adopt, localOnly],
    );

    const start = useCallback(
        async (description: string, project: string, opts: { notes?: string; at?: Date } = {}) => {
            if (!account) return;
            const timer: RunningTimer = { d: description, p: project, s: (opts.at ?? new Date()).toISOString(), dev: await deviceId() };
            if (opts.notes) timer.n = opts.notes;
            const { version: seen, timer: previous } = stateRef.current;
            // A start ends whatever was running at its start time.
            if (isRunning(previous)) await queueEntry(entryFromTimer({ ...previous, e: timer.s }));
            await run({ version: seen, timer }, () => startTimer(api, account.dek, account.user.id, seen, timer));
            flush();
            return timer.s;
        },
        [account, run, flush],
    );

    const stop = useCallback(async () => {
        const current = stateRef.current;
        if (!account || !current.timer) return;
        const end = new Date();
        const stopped = { ...current.timer, e: end.toISOString() };
        await queueEntry(entryFromTimer(stopped));
        await run({ version: current.version, timer: stopped }, () => stopTimer(api, account.dek, account.user.id, current, end));
        flush();
    }, [account, run, flush]);

    // Renames the running timer; its start stays, so desktops still recognise
    // it as the same timer. An edit that lost a race leaves the fresh state.
    const edit = useCallback(
        async (description: string, project: string) => {
            const current = stateRef.current;
            if (!account || !isRunning(current.timer)) return;
            const timer = { ...current.timer, d: description, p: project };
            await run({ version: current.version, timer }, async () => {
                try {
                    return await writeTimer(api, account.dek, account.user.id, current.version, timer);
                } catch (e) {
                    if (e instanceof TimerConflict) return e.fresh;
                    throw e;
                }
            });
        },
        [account, run],
    );

    return { state, loaded, localOnly, error, start, stop, edit, refresh };
}

type RunningTimerState = ReturnType<typeof useTimerState>;

const RunningTimerContext = createContext<RunningTimerState | null>(null);

// One poll for every screen and the masthead.
export function RunningTimerProvider({ children }: { children: ReactNode }) {
    return <RunningTimerContext.Provider value={useTimerState()}>{children}</RunningTimerContext.Provider>;
}

export function useRunningTimer() {
    const ctx = useContext(RunningTimerContext);
    if (!ctx) throw new Error('useRunningTimer outside RunningTimerProvider');
    return ctx;
}
