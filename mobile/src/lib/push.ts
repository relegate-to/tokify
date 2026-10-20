import * as Notifications from 'expo-notifications';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { dataToken } from '@/sync/account';
import { isTimerPush, pushSupported, registerDevice } from '@/sync/push';

// Registers this phone for the signed-in account on every launch (keeping
// last_seen fresh) and whenever FCM rotates the token. A timer push that
// arrives while the app is open refreshes the timer straight away; the
// regular poll covers the rest. Registration is best-effort: until the server
// has push_devices the phone simply gets no pushes.
export function usePushDevice(userId: string | undefined, onTimerPush: () => void) {
    useEffect(() => {
        if (!userId || !pushSupported) return;
        const register = (token?: string) =>
            dataToken()
                .then((jwt) => registerDevice(jwt, token))
                .catch(() => undefined);
        register();
        const sub = Notifications.addPushTokenListener(({ data }) => register(data as string));
        return () => sub.remove();
    }, [userId]);

    const latest = useRef(onTimerPush);
    useLayoutEffect(() => {
        latest.current = onTimerPush;
    }, [onTimerPush]);
    useEffect(() => {
        const sub = Notifications.addNotificationReceivedListener((n) => {
            if (isTimerPush(n)) latest.current();
        });
        return () => sub.remove();
    }, []);
}
