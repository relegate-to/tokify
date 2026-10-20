import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';

// The Neon endpoints come from the repo's .env, the same file the desktop's
// release builds read (see the Makefile), so they are never committed. Real
// environment variables win, for CI.
function repoEnv(): Record<string, string> {
    try {
        const text = readFileSync(resolve(__dirname, '../.env'), 'utf8');
        return Object.fromEntries(
            text
                .split('\n')
                .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
                .filter((m): m is RegExpMatchArray => m !== null)
                .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]),
        );
    } catch {
        return {};
    }
}

export default ({ config }: ConfigContext): ExpoConfig => {
    const env = { ...repoEnv(), ...process.env };
    // Firebase config is gitignored, so builds without it still work, just
    // without push.
    const googleServicesFile = env.GOOGLE_SERVICES_JSON ?? './google-services.json';
    return {
        ...(config as ExpoConfig),
        // Release builds stamp the version from the git tag; see release.yml.
        version: env.TOKIFY_VERSION ?? config.version,
        android: {
            ...config.android,
            ...(env.TOKIFY_VERSION_CODE && { versionCode: Number(env.TOKIFY_VERSION_CODE) }),
            ...(existsSync(resolve(__dirname, googleServicesFile)) && { googleServicesFile }),
        },
        extra: {
            ...config.extra,
            neonAuthUrl: env.NEON_AUTH_URL ?? '',
            neonDataUrl: env.NEON_DATA_URL ?? '',
            neonNotifyUrl: env.NEON_NOTIFY_URL ?? '',
        },
    };
};
