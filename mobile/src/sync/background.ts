// Timer pushes while the app is in the background or closed: Android starts
// the JS bundle headless and runs this task, which re-reads the running-timer
// record and redraws the ongoing notification. Defined at module scope from
// index.ts so it exists before the app renders.
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';

import { showTimerNotification } from '@/lib/timer-notification';

import { dataToken, loadAccount } from './account';
import { readTimer, TIMER_STATE_KEY } from './timer';
import { dataApi } from './timer-api';

const TASK = 'tokify-timer-push';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
    if (!data || 'actionIdentifier' in data) return;
    const account = await loadAccount();
    if (!account) return showTimerNotification(null);
    const fresh = await readTimer(dataApi(dataToken), account.dek);
    await SecureStore.setItemAsync(TIMER_STATE_KEY, JSON.stringify(fresh));
    showTimerNotification(fresh.timer);
});

Notifications.registerTaskAsync(TASK).catch(() => undefined);
