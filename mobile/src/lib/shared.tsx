import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/lib/session';
import { dataToken } from '@/sync/account';
import { cachedSharedActivities, listSharedEntries, sharingUnlocked, type SharedActivity } from '@/sync/sharing';
import { getMyInvites } from '@/sync/sharing-api';

const REFRESH_MS = 60_000;

type SharedState = { shared: SharedActivity[]; invites: number; refresh: () => Promise<void> };

const SharedContext = createContext<SharedState | null>(null);

// What teammates share with this account's teams, as the desktop's shared
// cache serves it: the last read straight away, then a fresh read in the
// background on open, on return to the app, and once a minute. Pending team
// invitations are counted on the same beat for the masthead's badge.
export function SharedProvider({ children }: { children: ReactNode }) {
    const { account } = useSession();
    const [shared, setShared] = useState<SharedActivity[]>(() => (account ? cachedSharedActivities(account.user.id) : []));
    const [invites, setInvites] = useState(0);
    const reading = useRef(false);

    const refresh = useCallback(async () => {
        if (!account) return;
        getMyInvites(await dataToken(), account.user.id)
            .then((rows) => setInvites(rows.length))
            .catch(() => undefined);
        if (reading.current || !(await sharingUnlocked())) return;
        reading.current = true;
        try {
            const next = (await listSharedEntries(account)).entries;
            // The poll rebuilds every row; adopt them only when they differ, or
            // the Log regroups and redraws its graph once a minute for nothing.
            setShared((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
        } catch {
            // Keep showing the last good read.
        } finally {
            reading.current = false;
        }
    }, [account]);

    useEffect(() => {
        setShared(account ? cachedSharedActivities(account.user.id) : []);
        setInvites(0);
        refresh();
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
    }, [account, refresh]);

    const value = useMemo(() => ({ shared, invites, refresh }), [shared, invites, refresh]);
    return <SharedContext.Provider value={value}>{children}</SharedContext.Provider>;
}

export function useShared() {
    const ctx = useContext(SharedContext);
    if (!ctx) throw new Error('useShared outside SharedProvider');
    return ctx;
}
