import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { loadAccount, signOut as endSession, type Account } from '@/sync/account';

type SessionState = {
    account: Account | null;
    loading: boolean;
    setAccount: (account: Account) => void;
    signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
    const [account, setAccount] = useState<Account | null>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        loadAccount()
            .then(setAccount)
            .finally(() => setLoading(false));
    }, []);
    const signOut = useCallback(async () => {
        await endSession();
        setAccount(null);
    }, []);
    return <SessionContext.Provider value={{ account, loading, setAccount, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
    const ctx = useContext(SessionContext);
    if (!ctx) throw new Error('useSession outside SessionProvider');
    return ctx;
}
