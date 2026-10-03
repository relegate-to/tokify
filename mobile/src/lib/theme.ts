import { DarkTheme, DefaultTheme, type Theme } from 'expo-router/react-navigation';

// Navigation chrome colours, matching the tokens in global.css.
export const NAV_THEME: Record<'light' | 'dark', Theme> = {
    light: {
        ...DefaultTheme,
        colors: {
            background: '#f7f7f7',
            border: '#e4e4e4',
            card: '#ffffff',
            notification: '#d6333a',
            primary: '#171717',
            text: '#171717',
        },
    },
    dark: {
        ...DarkTheme,
        colors: {
            background: '#121212',
            border: '#303030',
            card: '#1a1a1a',
            notification: '#ea5b5b',
            primary: '#fafafa',
            text: '#fafafa',
        },
    },
};
