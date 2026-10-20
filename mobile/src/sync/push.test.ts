import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyDevices, registerDevice, removeDevice } from './push';

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    deleteItemAsync: async (k: string) => void store.delete(k),
}));
vi.mock('expo-notifications', () => ({ getDevicePushTokenAsync: async () => ({ type: 'android', data: 'fcm:one' }) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('./config', () => ({ NOTIFY_URL: 'https://notify.test' }));
const calls: { path: string; init: { method?: string; body?: string } }[] = [];
vi.mock('./data', () => ({ dataFetch: vi.fn(async (_t: string, path: string, init: { method?: string; body?: string }) => void calls.push({ path, init })) }));

beforeEach(() => {
    store.clear();
    calls.length = 0;
});

describe('push registration', () => {
    it('registers the FCM token through the RPC and remembers it', async () => {
        await registerDevice('jwt');
        expect(calls).toEqual([{ path: '/rpc/register_push_device', init: { method: 'POST', body: '{"token":"fcm:one","platform":"android"}' } }]);
        expect(store.get('push.token')).toBe('fcm:one');
    });

    it('drops the old token when FCM rotates it', async () => {
        store.set('push.token', 'fcm:old');
        await registerDevice('jwt', 'fcm:new');
        expect(calls.map((c) => [c.init.method, c.path])).toEqual([
            ['POST', '/rpc/register_push_device'],
            ['DELETE', '/push_devices?token=eq.fcm%3Aold'],
        ]);
        expect(store.get('push.token')).toBe('fcm:new');
    });

    it('removes this phone on sign-out, and does nothing when it never registered', async () => {
        await removeDevice('jwt');
        expect(calls).toHaveLength(0);
        store.set('push.token', 'fcm:one');
        await removeDevice('jwt');
        expect(calls.map((c) => [c.init.method, c.path])).toEqual([['DELETE', '/push_devices?token=eq.fcm%3Aone']]);
        expect(store.has('push.token')).toBe(false);
    });
});

describe('notify', () => {
    it('sends the version and skips this phone', async () => {
        const fetchMock = vi.fn(async () => new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        store.set('push.token', 'fcm:one');
        await notifyDevices('jwt', 12);
        expect(fetchMock).toHaveBeenCalledWith('https://notify.test', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
            body: '{"version":12,"except":"fcm:one"}',
        });
        fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
        await expect(notifyDevices('jwt', 13)).rejects.toThrow('401');
        vi.unstubAllGlobals();
    });
});
