import '@/polyfills';
import '@/global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useUniwind } from 'uniwind';

import { SessionProvider, useSession } from '@/lib/session';
import { NAV_THEME } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
    const { theme } = useUniwind();
    const scheme = theme === 'dark' ? 'dark' : 'light';
    return (
        <KeyboardProvider>
            <ThemeProvider value={NAV_THEME[scheme]}>
                <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
                <SessionProvider>
                    <Routes />
                </SessionProvider>
                <PortalHost />
            </ThemeProvider>
        </KeyboardProvider>
    );
}

// Signed out, only sign-in is reachable; signed in, it is not.
function Routes() {
    const { account, loading } = useSession();
    if (loading) return null;
    return (
        <Stack screenOptions={{ headerShown: false }}>
            <Stack.Protected guard={account !== null}>
                <Stack.Screen name="index" />
                <Stack.Screen name="log" />
            </Stack.Protected>
            <Stack.Protected guard={account === null}>
                <Stack.Screen name="sign-in" />
            </Stack.Protected>
            <Stack.Screen name="crypto-check" />
        </Stack>
    );
}
