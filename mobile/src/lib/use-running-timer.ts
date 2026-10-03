import * as SecureStore from 'expo-secure-store';
import { randomBytes } from '@noble/hashes/utils.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { bytesToHex } from '@/crypto/bytes';
import type { RunningTimer } from '@/crypto/sync';
import { useSession } from '@/lib/session';
import { dataToken } from '@/sync/account';
import { readTimer, startTimer, stopTimer, type TimerState } from '@/sync/timer';
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
export function useRunningTimer() {
    const { account } = useSession();
    const [state, setState] = useState<TimerState>({ version: 0, timer: null });
    const [localOnly, setLocalOnly] = useState(false);
    const [error, setError] = useState('');
    const stateRef = useRef(state);

    const adopt = useCallback((next: TimerState) => {
        stateRef.current = next;
        setState(next);
        SecureStore.setItemAsync(STATE_KEY, JSON.stringify(next)).catch(() => undefined);
    }, []);

    const refresh = useCallback(async () => {
        if (!account || localOnly) return;
        try {
            const fresh = await readTimer(api, account.dek);
            if (fresh.version !== stateRef.current.version) adopt(fresh);
            setError('');
        } catch (e) {
            if (isMissingTable(e)) setLocalOnly(true);
            else setError(e instanceof Error ? e.message : String(e));
        }
    }, [account, localOnly, adopt]);

    useEffect(() => {
        SecureStore.getItemAsync(STATE_KEY)
            .then((cached) => cached && adopt(JSON.parse(cached) as TimerState))
            .finally(refresh);
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
        async (description: string, project: string) => {
            if (!account) return;
            const timer: RunningTimer = { d: description, p: project, s: new Date().toISOString(), dev: await deviceId() };
            const seen = stateRef.current.version;
            await run({ version: seen, timer }, () => startTimer(api, account.dek, account.user.id, seen, timer));
        },
        [account, run],
    );

    const stop = useCallback(async () => {
        const current = stateRef.current;
        if (!account || !current.timer) return;
        const end = new Date();
        await run({ version: current.version, timer: { ...current.timer, e: end.toISOString() } }, () =>
            stopTimer(api, account.dek, account.user.id, current, end),
        );
    }, [account, run]);

    return { state, localOnly, error, start, stop, refresh };
}
