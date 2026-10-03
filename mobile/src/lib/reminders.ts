import * as Notifications from 'expo-notifications';

import type { RunningTimer } from '@/crypto/sync';
import { formatTotal, parseInstant } from '@/lib/time';

const EVERY_MS = 2 * 60 * 60_000;
const UNTIL_MS = 8 * 60 * 60_000;

Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

let scheduledFor: string | null = null;

// Reminds you a timer is still running, every two hours up to eight, wherever
// it was started. Scheduled on the phone, so it needs no push and the title
// never leaves the device.
export async function syncReminders(timer: RunningTimer | null) {
    const key = timer ? `${timer.s}\0${timer.d}` : null;
    if (key === scheduledFor) return;
    scheduledFor = key;
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (!timer) return;

    const { granted } = await Notifications.requestPermissionsAsync();
    if (!granted) return;
    const start = parseInstant(timer.s).getTime();
    for (let at = start + EVERY_MS; at <= start + UNTIL_MS; at += EVERY_MS) {
        if (at <= Date.now()) continue;
        await Notifications.scheduleNotificationAsync({
            content: {
                title: 'Timer still running',
                body: `${timer.d || timer.p || 'Activity'} has been running for ${formatTotal(at - start)}.`,
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at) },
        });
    }
}
