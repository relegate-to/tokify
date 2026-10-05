import { getRandomValues } from 'expo-crypto';

// Hermes has no Web Crypto; noble draws nonces from globalThis.crypto.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    Object.defineProperty(globalThis, 'crypto', {
        value: { ...globalThis.crypto, getRandomValues },
        configurable: true,
    });
}
