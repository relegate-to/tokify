import * as Haptics from 'expo-haptics';
import { Play } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Keyboard, ScrollView, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/components/safe-area-view';

import { JumpBackIn } from '@/components/JumpBackIn';
import { NowRunning } from '@/components/NowRunning';
import { Starter, type StarterDraft } from '@/components/Starter';
import { TodayGoal } from '@/components/TodayGoal';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useEntries } from '@/lib/entries';
import { dayLabel, parseInstant, parseSyncTime } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { useRunningTimer } from '@/lib/running-timer';
import type { Entry } from '@/sync/entries';
import { isRunning } from '@/sync/timer';

const QUICK_START_COUNT = 4;
const DAILY_GOAL_MINUTES = 360;

const quickStartKey = (description: string, project: string) => JSON.stringify([description, project]);

// Now: start a timer, or see and stop the one that is running on any device.
export function NowPage() {
    const insets = useSafeAreaInsets();
    const [draft, setDraft] = useState<Omit<StarterDraft, 'project'>>({ description: '', notes: '', startAt: null });
    const [picked, setPicked] = useState<string | null>(null);
    const [startError, setStartError] = useState('');
    const { state, localOnly, error, start: startTimer, stop, edit } = useRunningTimer();
    const { entries } = useEntries();
    const running = isRunning(state.timer) ? state.timer : null;
    const now = useNow();

    // As on the desktop (NowView): the last few distinct activities, the
    // project last tracked against as the starter's default, and today's total
    // including the running timer.
    const { quickStarts, contextLabel, projects, defaultProject, todayMs } = useMemo(() => {
        const list = entries ?? [];
        const runningKey = running ? quickStartKey(running.d, running.p) : null;
        const seen = new Set<string>();
        const quick: Entry[] = [];
        const projectSet = new Set<string>();
        for (const e of list) {
            if (e.project) projectSet.add(e.project);
            const key = quickStartKey(e.description, e.project);
            if (!e.description || key === runningKey || seen.has(key) || quick.length >= QUICK_START_COUNT) continue;
            seen.add(key);
            quick.push(e);
        }
        const labels = new Set(quick.map((e) => dayLabel(parseSyncTime(e.start))));
        const today = new Date();
        const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        let total = 0;
        for (const e of list) {
            const from = parseSyncTime(e.start).getTime();
            if (from >= midnight) total += parseSyncTime(e.end).getTime() - from;
        }
        return {
            quickStarts: quick,
            contextLabel: labels.size === 1 ? [...labels][0] : quick.length ? 'Recent' : '',
            projects: [...projectSet],
            defaultProject: list.find((e) => e.project)?.project ?? '',
            todayMs: total,
        };
    }, [entries, running]);
    const runningMs = running ? Math.max(0, now - Math.max(parseInstant(running.s).getTime(), new Date(new Date(now).setHours(0, 0, 0, 0)).getTime())) : 0;
    const project = picked ?? defaultProject;

    const canStart = draft.description.trim().length > 0;
    const start = () => {
        if (!canStart) return;
        let at: Date | undefined;
        if (draft.startAt !== null && draft.startAt.trim() !== '') {
            // As the desktop's buildClockISO: HH:MM today, and in the past.
            const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(draft.startAt);
            if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return setStartError('Start time must be HH:MM');
            at = new Date();
            at.setHours(Number(m[1]), Number(m[2]), 0, 0);
            if (at.getTime() > Date.now()) return setStartError('Start time must be in the past');
        }
        setStartError('');
        Keyboard.dismiss();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        startTimer(draft.description.trim(), project, { notes: draft.notes.trim() || undefined, at });
        setDraft({ description: '', notes: '', startAt: null });
        setPicked(null);
    };

    return (
        <SafeAreaView className="flex-1" edges={['bottom']}>
            <View style={{ flex: 1 }}>
                <ScrollView className="flex-1" contentContainerClassName="gap-6 px-5 pb-6 pt-4" keyboardShouldPersistTaps="handled">
                    {running ? (
                        <NowRunning description={running.d} project={running.p} start={parseInstant(running.s)} projects={projects} onStop={stop} onEdit={edit} />
                    ) : (
                        <Starter
                            draft={{ ...draft, project }}
                            projects={projects}
                            onChange={({ project: p, ...rest }) => {
                                if (p !== undefined) setPicked(p);
                                setDraft((d) => ({ ...d, ...rest }));
                            }}
                            onSubmit={start}
                        />
                    )}
                    {entries !== null ? <TodayGoal totalMs={todayMs + runningMs} goalMinutes={DAILY_GOAL_MINUTES} /> : null}
                    {quickStarts.length > 0 ? (
                        <JumpBackIn items={quickStarts} contextLabel={contextLabel} onResume={(e) => startTimer(e.description, e.project)} />
                    ) : null}
                    {error || startError ? <Text className="text-sm text-destructive">{startError || error}</Text> : null}
                    {localOnly ? (
                        <Text className="text-sm text-muted-foreground">This timer stays on this phone until the server is updated for timer sync.</Text>
                    ) : null}
                </ScrollView>
                {!running && (
                    // Inside the pager KeyboardAvoidingView misjudges the page's position, so
                    // the bar rides the keyboard directly. It already sits above the bottom
                    // inset, which the keyboard also covers, hence the offset.
                    <KeyboardStickyView offset={{ opened: insets.bottom }}>
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
                    </KeyboardStickyView>
                )}
            </View>
        </SafeAreaView>
    );
}
