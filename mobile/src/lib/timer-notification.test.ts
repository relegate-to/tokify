import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn() }));
vi.mock('../../modules/tokify-timer-notification', () => ({ default: native }));
vi.mock('expo-notifications', () => ({}));

import { showTimerNotification } from './timer-notification';

describe('the running-timer notification', () => {
    it('shows a running timer counting from its start, nanoseconds and all', () => {
        showTimerNotification({ d: 'Plan', p: 'tokify', s: '2026-10-19T17:00:00.123456789+09:00', dev: 'mac' });
        expect(native.show).toHaveBeenLastCalledWith('Plan', 'tokify', Date.UTC(2026, 9, 19, 8, 0, 0, 123));
    });

    it('labels a timer without description or project like the app does', () => {
        showTimerNotification({ d: '', p: '', s: '2026-10-19T08:00:00Z', dev: 'mac' });
        expect(native.show).toHaveBeenLastCalledWith('No description', 'No project', Date.UTC(2026, 9, 19, 8));
    });

    it('clears it once the timer stops or there is none', () => {
        native.hide.mockClear();
        showTimerNotification({ d: 'Plan', p: 'tokify', s: '2026-10-19T08:00:00Z', e: '2026-10-19T09:00:00Z', dev: 'mac' });
        showTimerNotification(null);
        expect(native.hide).toHaveBeenCalledTimes(2);
    });
});
