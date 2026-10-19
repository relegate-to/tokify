// This phone's place in push_devices (push_schema.sql) and calls to the notify
// Function (functions/), which pushes "the running timer changed" to the
// account's other phones. Android only until iOS has an APNs key in Firebase.
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { NOTIFY_URL } from './config';
import { dataFetch } from './data';

const TOKEN_KEY = 'push.token';

export const pushSupported = Platform.OS === 'android';

// Registers the phone's FCM token for the signed-in account, or refreshes its
// last-seen time. A rotated token replaces the one registered before.
export async function registerDevice(jwt: string, token?: string) {
    if (!pushSupported) return;
    token ??= (await Notifications.getDevicePushTokenAsync()).data as string;
    await dataFetch(jwt, '/rpc/register_push_device', { method: 'POST', body: JSON.stringify({ token, platform: Platform.OS }) });
    const previous = await SecureStore.getItemAsync(TOKEN_KEY);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    if (previous && previous !== token) await deleteDevice(jwt, previous).catch(() => undefined);
}

// Before signing out, so the account stops pushing to this phone.
export async function removeDevice(jwt: string) {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) return;
    await deleteDevice(jwt, token);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
}

function deleteDevice(jwt: string, token: string) {
    return dataFetch(jwt, `/push_devices?token=eq.${encodeURIComponent(token)}`, { method: 'DELETE', prefer: 'return=minimal' });
}

// Tells the account's other phones that the running timer is now at version.
// The push carries that number and a timestamp, nothing about the timer.
export async function notifyDevices(jwt: string, version: number) {
    if (!NOTIFY_URL) return;
    const except = await SecureStore.getItemAsync(TOKEN_KEY);
    const res = await fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(except ? { version, except } : { version }),
    });
    if (!res.ok) throw new Error(`Notify failed (${res.status})`);
}

export function isTimerPush(n: Notifications.Notification) {
    return (n.request.content.data as { type?: unknown } | null)?.type === 'timer';
}
