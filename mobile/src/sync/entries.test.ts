import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({}));
vi.mock('./data', () => ({ dataFetch: vi.fn() }));

import { entryFromTimer, syncTime } from './entries';

describe('entries from the phone', () => {
    it('formats times as the desktop sync format, in local time', () => {
        expect(syncTime(new Date(2026, 9, 3, 9, 5, 59))).toBe('2026-10-03 09:05');
    });

    it('rounds a desktop nanosecond start down to the minute like the desktop', () => {
        const start = new Date(2026, 9, 3, 9, 30, 15, 123);
        const end = new Date(2026, 9, 3, 10, 45, 59);
        const e = entryFromTimer({ d: 'Plan', p: 'tokify', s: start.toISOString().replace('Z', '456Z'), e: end.toISOString(), dev: 'mac' });
        expect(e).toEqual({ description: 'Plan', project: 'tokify', start: '2026-10-03 09:30', end: '2026-10-03 10:45' });
    });
});
