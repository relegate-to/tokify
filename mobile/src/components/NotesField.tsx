import { useMemo } from 'react';
import { View } from 'react-native';
import { useCSSVariable } from 'uniwind';

import NotesEditor from '@/dom/NotesEditor';
import { cn } from '@/lib/utils';

const THEME_VARS = ['--color-foreground', '--color-muted-foreground', '--color-muted', '--color-border', '--color-destructive'];

// Rich activity notes in a framed field, the same HTML the desktop writes.
export function NotesField({ value, onChange, placeholder, className }: { value: string; onChange: (html: string) => void; placeholder: string; className?: string }) {
    const colors = useCSSVariable(THEME_VARS);
    const theme = useMemo(
        () => Object.fromEntries(THEME_VARS.map((name, i) => [name.replace('--color-', ''), String(colors[i] ?? '')])),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [colors.join()],
    );
    return (
        <View className={cn('h-40 overflow-hidden rounded-lg border border-input bg-card', className)}>
            <NotesEditor
                value={value}
                placeholder={placeholder}
                theme={theme}
                onChange={async (html) => onChange(html)}
                dom={{ style: { flex: 1, backgroundColor: 'transparent' }, containerStyle: { flex: 1 }, nestedScrollEnabled: true, showsVerticalScrollIndicator: false }}
            />
        </View>
    );
}
