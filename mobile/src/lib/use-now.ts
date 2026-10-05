import { useEffect, useState } from 'react';

// Re-renders every second, aligned to the wall clock so a stopwatch ticks on
// the second rather than drifting.
export function useNow() {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const tick = () => {
            setNow(Date.now());
            timer = setTimeout(tick, 1000 - (Date.now() % 1000));
        };
        timer = setTimeout(tick, 1000 - (Date.now() % 1000));
        return () => clearTimeout(timer);
    }, []);
    return now;
}
