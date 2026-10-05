import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Uniwind } from 'uniwind';

// The desktop's appearance settings (tokify.theme, tokify.activityView,
// tokify.dailyGoal, tokify.autoCompleteTodos), kept on this phone. Read
// synchronously so the first frame already has the right theme.

export type Theme = 'auto' | 'light' | 'dark';
export type ActivityView = 'all' | 'today' | 'none';
export const DAILY_GOALS = [240, 360, 480] as const;

export type Prefs = { theme: Theme; activityView: ActivityView; dailyGoal: number; autoCompleteTodos: boolean };

const KEYS = { theme: 'prefs.theme', activityView: 'prefs.activityView', dailyGoal: 'prefs.dailyGoal', autoCompleteTodos: 'todos.autoComplete' };

function read(): Prefs {
    const get = (key: string) => {
        try {
            return SecureStore.getItem(key);
        } catch {
            return null;
        }
    };
    const theme = get(KEYS.theme);
    const view = get(KEYS.activityView);
    const goal = Number(get(KEYS.dailyGoal));
    return {
        theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
        activityView: view === 'today' || view === 'none' ? view : 'all',
        dailyGoal: (DAILY_GOALS as readonly number[]).includes(goal) ? goal : 360,
        autoCompleteTodos: get(KEYS.autoCompleteTodos) === '1',
    };
}

function write<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    const raw = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    SecureStore.setItemAsync(KEYS[key], raw).catch(() => undefined);
}

function applyTheme(theme: Theme) {
    Uniwind.setTheme(theme === 'auto' ? 'system' : theme);
}

type PrefsState = Prefs & { set: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void };

const PrefsContext = createContext<PrefsState | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
    const [prefs, setPrefs] = useState(read);
    useEffect(() => applyTheme(prefs.theme), [prefs.theme]);
    const set = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
        write(key, value);
        setPrefs((p) => ({ ...p, [key]: value }));
    }, []);
    return <PrefsContext.Provider value={{ ...prefs, set }}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
    const ctx = useContext(PrefsContext);
    if (!ctx) throw new Error('usePrefs outside PrefsProvider');
    return ctx;
}
