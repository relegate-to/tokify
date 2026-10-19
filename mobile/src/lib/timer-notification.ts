import * as Notifications from 'expo-notifications';

import TimerNotification from '../../modules/tokify-timer-notification';
import type { RunningTimer } from '@/crypto/sync';
import { parseInstant } from '@/lib/time';
import { isRunning } from '@/sync/timer';

// Mirrors the account's running timer into an ongoing Android notification,
// or clears it when nothing runs. The title is decrypted on the phone; the
// push that triggers an update never carries it.
export function showTimerNotification(timer: RunningTimer | null) {
    if (!TimerNotification) return;
    if (!isRunning(timer)) return TimerNotification.hide();
    TimerNotification.show(timer.d || 'No description', timer.p || 'No project', parseInstant(timer.s).getTime());
}

// Android 13+ needs the user's yes before any notification shows. Asked the
// first time the phone sees a running timer.
export async function askForNotifications() {
    if (!TimerNotification) return false;
    const { granted, canAskAgain } = await Notifications.getPermissionsAsync();
    if (granted || !canAskAgain) return granted;
    return (await Notifications.requestPermissionsAsync()).granted;
}
