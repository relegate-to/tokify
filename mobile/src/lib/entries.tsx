import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { syncProjectColors } from '@/lib/project-colors';
import { reconcileSoon } from '@/lib/share-sync';
import { useSession } from '@/lib/session';
import { dataToken } from '@/sync/account';
import { listEntries, syncTime, type Entry } from '@/sync/entries';

type EntriesState = { entries: Entry[] | null; error: string; reload: () => Promise<void> };

const EntriesContext = createContext<EntriesState | null>(null);

// The decrypted history, shared by Now (today's total, jump back in) and Log.
export function EntriesProvider({ children }: { children: ReactNode }) {
    const { account } = useSession();
    const [entries, setEntries] = useState<Entry[] | null>(null);
    const [error, setError] = useState('');
    const current = useRef<{ owner: string; day: string; entries: Entry[] } | null>(null);
    const reload = useCallback(async () => {
        if (!account) return;
        const owner = account.user.id;
        const prev = current.current?.owner === owner ? current.current : null;
        try {
            const list = await listEntries(await dataToken(), account.dek, owner, prev ? new Map(prev.entries.map((e) => [e.id, e])) : undefined);
            // A reload that learns nothing new keeps the same array, so the
            // pages built from it don't redo their work. Past midnight it
            // doesn't, since "Today" and the week have moved underneath it.
            const day = syncTime(new Date()).slice(0, 10);
            const same = prev && prev.day === day && prev.entries.length === list.length && prev.entries.every((e, i) => e === list[i]);
            const next = same ? prev.entries : list;
            current.current = { owner, day, entries: next };
            setEntries(next);
            setError('');
            reconcileSoon(account, next);
            syncProjectColors(account);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [account]);
    useEffect(() => {
        // Now above the signed-in screens, so a sign-out mustn't leave the last
        // account's history behind.
        if (!account) {
            current.current = null;
            setEntries(null);
        }
        reload();
    }, [reload, account]);
    const value = useMemo(() => ({ entries, error, reload }), [entries, error, reload]);
    return <EntriesContext.Provider value={value}>{children}</EntriesContext.Provider>;
}

export function useEntries() {
    const ctx = useContext(EntriesContext);
    if (!ctx) throw new Error('useEntries outside EntriesProvider');
    return ctx;
}
