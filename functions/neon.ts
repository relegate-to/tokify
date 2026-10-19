import { defineConfig } from '@neon/config/v1';

// FCM_SERVICE_ACCOUNT is the Firebase service-account JSON, base64-encoded.
// Keep it in the gitignored env file passed to `neon deploy --env`.
export default defineConfig({
    functions: {
        notify: {
            name: 'push notify',
            source: 'src/notify.ts',
            env: { FCM_SERVICE_ACCOUNT: process.env.FCM_SERVICE_ACCOUNT! },
        },
    },
});
