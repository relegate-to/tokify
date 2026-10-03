import '@/polyfills';
import '@/global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useUniwind } from 'uniwind';

import { NAV_THEME } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
    const { theme } = useUniwind();
    const scheme = theme === 'dark' ? 'dark' : 'light';
    return (
        <KeyboardProvider>
            <ThemeProvider value={NAV_THEME[scheme]}>
                <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
                <Stack screenOptions={{ headerShown: false }} />
                <PortalHost />
            </ThemeProvider>
        </KeyboardProvider>
    );
}
