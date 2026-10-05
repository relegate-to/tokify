import * as Haptics from 'expo-haptics';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { EASE_SIZE, enter } from '@/lib/motion';

// The desktop's undo, as a phone snackbar: after a delete or an edit, a few
// seconds to take it back.
const SHOW_MS = 6000;

type Offer = { key: number; label: string; undo: () => Promise<void> };
type Undo = (label: string, undo: () => Promise<void>) => void;

const UndoContext = createContext<Undo | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
    const insets = useSafeAreaInsets();
    const [offer, setOffer] = useState<Offer | null>(null);
    const [busy, setBusy] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seq = useRef(0);

    const dismiss = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        setOffer(null);
    }, []);

    const offerUndo = useCallback<Undo>(
        (label, undo) => {
            if (timer.current) clearTimeout(timer.current);
            setOffer({ key: ++seq.current, label, undo });
            timer.current = setTimeout(dismiss, SHOW_MS);
        },
        [dismiss],
    );

    useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

    const run = async () => {
        if (!offer || busy) return;
        setBusy(true);
        try {
            await offer.undo();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        } finally {
            setBusy(false);
            dismiss();
        }
    };

    return (
        <UndoContext.Provider value={offerUndo}>
            {children}
            {offer ? (
                <Animated.View
                    key={offer.key}
                    entering={enter({ dy: 12, duration: 300, easing: EASE_SIZE })}
                    exiting={FadeOut.duration(150)}
                    pointerEvents="box-none"
                    style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 16 }}
                >
                    <View className="flex-row items-center gap-3 rounded-xl bg-running-card py-2 pl-4 pr-2 shadow-lg shadow-black/25">
                        <Text numberOfLines={1} className="flex-1 text-[15px] text-running-card-foreground">
                            {offer.label}
                        </Text>
                        <Pressable onPress={run} disabled={busy} accessibilityRole="button" className="rounded-lg px-3 py-2 active:bg-running-card-foreground/10">
                            <Text className="font-sans-semibold text-[15px] text-running-card-foreground">{busy ? 'Undoing…' : 'Undo'}</Text>
                        </Pressable>
                    </View>
                </Animated.View>
            ) : null}
        </UndoContext.Provider>
    );
}

export function useUndo() {
    const ctx = useContext(UndoContext);
    if (!ctx) throw new Error('useUndo outside UndoProvider');
    return ctx;
}
