import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { neonAuthUrl?: string; neonDataUrl?: string };

export const AUTH_URL = (extra.neonAuthUrl ?? '').replace(/\/+$/, '');
export const DATA_URL = (extra.neonDataUrl ?? '').replace(/\/+$/, '');
