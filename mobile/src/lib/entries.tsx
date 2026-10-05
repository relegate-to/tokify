import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { syncProjectColors } from '@/lib/project-colors';
import { reconcileSoon } from '@/lib/share-sync';
import { useSession } from '@/lib/session';
import { dataToken } from '@/sync/account';
import { listEntries, type Entry } from '@/sync/entries';

type EntriesState = { entries: Entry[] | null; error: string; reload: () => Promise<void> };

const EntriesContext = createContext<EntriesState | null>(null);

// The decrypted history, shared by Now (today's total, jump back in) and Log.
export function EntriesProvider({ children }: { children: ReactNode }) {
    const { account } = useSession();
    const [entries, setEntries] = useState<Entry[] | null>(null);
    const [error, setError] = useState('');
    const reload = useCallback(async () => {
        if (!account) return;
        try {
            const list = await listEntries(await dataToken(), account.dek, account.user.id);
            setEntries(list);
            setError('');
            reconcileSoon(account, list);
            syncProjectColors(account);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [account]);
    useEffect(() => {
        // Now above the signed-in screens, so a sign-out mustn't leave the last
        // account's history behind.
        if (!account) setEntries(null);
        reload();
    }, [reload, account]);
    return <EntriesContext.Provider value={{ entries, error, reload }}>{children}</EntriesContext.Provider>;
}

export function useEntries() {
    const ctx = useContext(EntriesContext);
    if (!ctx) throw new Error('useEntries outside EntriesProvider');
    return ctx;
}
