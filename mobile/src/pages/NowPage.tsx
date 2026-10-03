import { Play } from 'lucide-react-native';
import { useState } from 'react';
import { Keyboard, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from '@/components/safe-area-view';

import { NowRunning } from '@/components/NowRunning';
import { Starter } from '@/components/Starter';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { parseInstant } from '@/lib/time';
import { useRunningTimer } from '@/lib/running-timer';
import { isRunning } from '@/sync/timer';

// Now: start a timer, or see and stop the one that is running on any device.
export function NowPage() {
    const [draft, setDraft] = useState('');
    const { state, localOnly, error, start: startTimer, stop } = useRunningTimer();
    const running = isRunning(state.timer) ? state.timer : null;

    const canStart = draft.trim().length > 0;
    const start = () => {
        if (!canStart) return;
        Keyboard.dismiss();
        startTimer(draft.trim(), '');
        setDraft('');
    };

    return (
        <SafeAreaView className="flex-1" edges={['bottom']}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <ScrollView className="flex-1" contentContainerClassName="gap-6 px-5 pt-4" keyboardShouldPersistTaps="handled">
                    {running ? (
                        <NowRunning description={running.d} project={running.p} start={parseInstant(running.s)} onStop={stop} />
                    ) : (
                        <Starter description={draft} project="" onChange={setDraft} onSubmit={start} />
                    )}
                    {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                    {localOnly ? (
                        <Text className="text-sm text-muted-foreground">This timer stays on this phone until the server is updated for timer sync.</Text>
                    ) : null}
                </ScrollView>
                {!running && (
                    <View className="px-5 pb-3 pt-2">
                        <Button
                            size="lg"
                            variant={canStart ? 'default' : 'secondary'}
                            className="h-14 rounded-xl opacity-100"
                            disabled={!canStart}
                            onPress={start}
                        >
                            <Icon as={Play} className={canStart ? 'size-4 text-primary-foreground' : 'size-4 text-muted-foreground'} />
                            <Text className={canStart ? 'font-sans-semibold text-base' : 'font-sans-semibold text-base text-muted-foreground'}>
                                Start
                            </Text>
                        </Button>
                    </View>
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
