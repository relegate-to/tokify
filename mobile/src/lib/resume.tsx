import * as Haptics from 'expo-haptics';
import { Play } from 'lucide-react-native';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useRunningTimer } from '@/lib/running-timer';
import { formatTotal, parseInstant } from '@/lib/time';
import { isRunning } from '@/sync/timer';

type Start = { description: string; project: string; notes?: string };
type Pending = Start & { resolve: (started: string | undefined) => void };

// resume starts an activity again, asking first when it would stop the one
// that's running. It settles with the new timer's start, or undefined when
// nothing started.
type Resume = (start: Start) => Promise<string | undefined>;

const ResumeContext = createContext<Resume | null>(null);

export function ResumeProvider({ children }: { children: ReactNode }) {
    const { state, start } = useRunningTimer();
    const [pending, setPending] = useState<Pending | null>(null);
    const running = isRunning(state.timer) ? state.timer : null;
    const runningRef = useRef(running);
    runningRef.current = running;

    const go = useCallback(
        (s: Start) => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
            return start(s.description, s.project, { notes: s.notes });
        },
        [start],
    );

    const resume = useCallback<Resume>(
        async (s) => {
            const current = runningRef.current;
            if (!current) return go(s);
            if (current.d === s.description && current.p === s.project) return undefined;
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
            return new Promise((resolve) => setPending({ ...s, resolve }));
        },
        [go],
    );

    const answer = async (confirmed: boolean) => {
        if (!pending) return;
        setPending(null);
        pending.resolve(confirmed ? await go(pending) : undefined);
    };

    const elapsed = running ? formatTotal(Date.now() - parseInstant(running.s).getTime()) : '';
    return (
        <ResumeContext.Provider value={resume}>
            {children}
            <Dialog open={pending !== null} onOpenChange={(open) => !open && answer(false)}>
                <DialogContent className="w-[92vw] max-w-md">
                    <DialogHeader>
                        <DialogTitle>Switch to “{pending?.description}”?</DialogTitle>
                        <DialogDescription>
                            “{running?.d || running?.p || 'Your activity'}” has been running for {elapsed}. Switching stops it and keeps its time in the log.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onPress={() => answer(false)}>
                            <Text>Keep running</Text>
                        </Button>
                        <Button onPress={() => answer(true)}>
                            <Icon as={Play} className="size-4 text-primary-foreground" />
                            <Text>Switch</Text>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </ResumeContext.Provider>
    );
}

export function useResume() {
    const ctx = useContext(ResumeContext);
    if (!ctx) throw new Error('useResume outside ResumeProvider');
    return ctx;
}
