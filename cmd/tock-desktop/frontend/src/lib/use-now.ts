import { useEffect, useState } from 'react';

const TICK_MS = 1_000;

export function useNow(enabled = true) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!enabled) return;
        setNow(Date.now());
        const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
        return () => window.clearInterval(id);
    }, [enabled]);

    return now;
}
