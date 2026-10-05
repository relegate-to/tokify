import * as Haptics from 'expo-haptics';
import { Bold, Check, Folder, Heading2, IndentDecrease, IndentIncrease, Italic, KeyboardOff, List, ListTodo } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCSSVariable } from 'uniwind';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import SketchpadEditor, { type EditorCommand, type EditorState, type SketchpadHandle, type StartTodo } from '@/dom/SketchpadEditor';
import { projectColorClass } from '@/lib/colors';
import { useEntries } from '@/lib/entries';
import { useRunningTimer } from '@/lib/running-timer';
import {
    completeTodo,
    readAutoComplete,
    readSketchpad,
    readTodoRuns,
    writeAutoComplete,
    writeSketchpad,
    writeTodoRuns,
    type TodoRun,
} from '@/lib/sketchpad';
import { cn } from '@/lib/utils';
import { isRunning } from '@/sync/timer';

const THEME_VARS = ['--color-foreground', '--color-muted-foreground', '--color-muted', '--color-border'];

const IDLE: EditorState = { focused: false, task: false, bold: false, italic: false, heading: false, bullet: false, list: false };

// The desktop's sketchpad: a free-form pad, unlabelled and to the left of
// Activity, whose to-dos start activities and get ticked off when those stop.
export function SketchpadPage({ onStarted }: { onStarted: () => void }) {
    const editor = useRef<SketchpadHandle>(null);
    const [value, setValue] = useState(readSketchpad);
    const text = useRef(value);
    const [editing, setEditing] = useState(IDLE);
    const [finishing, setFinishing] = useState<TodoRun | null>(null);
    const { state, loaded, start } = useRunningTimer();
    const { entries } = useEntries();
    const insets = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboard.height.value, insets.bottom) }));

    const colors = useCSSVariable(THEME_VARS);
    const theme = useMemo(
        () => Object.fromEntries(THEME_VARS.map((name, i) => [name.replace('--color-', ''), String(colors[i] ?? '')])),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [colors.join()],
    );
    const projects = useMemo(() => [...new Set((entries ?? []).map((e) => e.project).filter(Boolean))], [entries]);

    const save = useCallback(async (html: string) => {
        text.current = html;
        writeSketchpad(html);
    }, []);

    const tick = useCallback((ids: string[]) => {
        let html = text.current;
        let ticked = 0;
        for (const id of ids) {
            const next = completeTodo(html, id);
            if (next !== null) {
                html = next;
                ticked++;
            }
        }
        if (!ticked) return;
        text.current = html;
        writeSketchpad(html);
        setValue(html);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    }, []);

    const startTodo = useCallback(
        async (todo: StartTodo) => {
            const started = await start(todo.description, todo.project, { notes: todo.notes });
            if (!started) return;
            await writeTodoRuns([...(await readTodoRuns()), { start: started, id: todo.id, description: todo.description }]);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
            onStarted();
        },
        [start, onStarted],
    );

    // As the desktop: an activity started from a to-do has finished once it's
    // no longer the running one, however it was stopped.
    const runningStart = isRunning(state.timer) ? state.timer.s : null;
    useEffect(() => {
        if (!loaded || finishing) return;
        let cancelled = false;
        (async () => {
            const runs = await readTodoRuns();
            const finished = runs.filter((run) => run.start !== runningStart);
            if (cancelled || finished.length === 0) return;
            if (!(await readAutoComplete())) return setFinishing(finished[0]);
            await writeTodoRuns(runs.filter((run) => run.start === runningStart));
            tick(finished.map((run) => run.id));
        })();
        return () => {
            cancelled = true;
        };
    }, [loaded, runningStart, finishing, tick]);

    const answer = async (done: boolean, always: boolean) => {
        const todo = finishing;
        if (!todo) return;
        await writeTodoRuns((await readTodoRuns()).filter((run) => run.start !== todo.start));
        if (done) tick([todo.id]);
        if (always) await writeAutoComplete(true);
        setFinishing(null);
    };

    const run = (command: EditorCommand) => {
        Haptics.selectionAsync().catch(() => undefined);
        editor.current?.run(command);
    };

    return (
        <Animated.View style={[{ flex: 1 }, lift]}>
            <SketchpadEditor
                ref={editor}
                value={value}
                theme={theme}
                onChange={save}
                onStartTodo={startTodo}
                onState={async (s) => setEditing(s)}
                dom={{ style: { flex: 1, backgroundColor: 'transparent' }, containerStyle: { flex: 1 }, overScrollMode: 'never' }}
            />
            {editing.focused ? (
                <View className="flex-row items-center gap-0.5 border-t border-border bg-background px-2 py-1.5">
                    <Pressable
                        onPress={() => run('task')}
                        accessibilityRole="button"
                        accessibilityState={{ selected: editing.task }}
                        className={cn('h-9 flex-row items-center gap-1.5 rounded-lg px-2.5', editing.task ? 'bg-muted' : 'active:bg-muted')}
                    >
                        <Icon as={ListTodo} className={cn('size-[17px]', editing.task ? 'text-foreground' : 'text-muted-foreground')} />
                        <Text className={cn('font-sans-medium text-[13px]', editing.task ? 'text-foreground' : 'text-muted-foreground')}>To-do</Text>
                    </Pressable>
                    <DropdownMenu>
                        <DropdownMenuTrigger className="size-9 items-center justify-center rounded-lg active:bg-muted" accessibilityLabel="Start a project section">
                            <Icon as={Folder} className="size-[17px] text-muted-foreground" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="top" align="start" className="min-w-56">
                            {[...projects, ''].map((p) => (
                                <DropdownMenuItem key={p || '\0none'} onPress={() => editor.current?.insertProject(p)}>
                                    <View className={cn('size-[7px] rounded-[2px]', p ? projectColorClass(p) : 'bg-idle-dot')} />
                                    <Text>{p || 'No project'}</Text>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <View className="mx-1 h-4 w-px bg-border" />
                    <Tool icon={Bold} label="Bold" active={editing.bold} onPress={() => run('bold')} />
                    <Tool icon={Italic} label="Italic" active={editing.italic} onPress={() => run('italic')} />
                    <Tool icon={Heading2} label="Heading" active={editing.heading} onPress={() => run('heading')} />
                    <Tool icon={List} label="Bulleted list" active={editing.bullet} onPress={() => run('bullet')} />
                    {editing.list ? (
                        <>
                            <Tool icon={IndentDecrease} label="Outdent" onPress={() => run('lift')} />
                            <Tool icon={IndentIncrease} label="Indent" onPress={() => run('sink')} />
                        </>
                    ) : null}
                    <View className="flex-1" />
                    <Tool icon={KeyboardOff} label="Done editing" onPress={() => run('blur')} />
                </View>
            ) : null}
            <FinishTodoDialog description={finishing?.description ?? null} onAnswer={answer} />
        </Animated.View>
    );
}

function Tool({ icon, label, active = false, onPress }: { icon: typeof Bold; label: string; active?: boolean; onPress: () => void }) {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            className={cn('size-9 items-center justify-center rounded-lg', active ? 'bg-muted' : 'active:bg-muted')}
        >
            <Icon as={icon} className={cn('size-[17px]', active ? 'text-foreground' : 'text-muted-foreground')} />
        </Pressable>
    );
}

// The desktop's FinishTodoDialog.
function FinishTodoDialog({ description, onAnswer }: { description: string | null; onAnswer: (done: boolean, always: boolean) => void }) {
    const [always, setAlways] = useState(false);
    useEffect(() => {
        if (description !== null) setAlways(false);
    }, [description]);
    return (
        <Dialog open={description !== null} onOpenChange={(open) => !open && onAnswer(false, false)}>
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>Is this to-do done?</DialogTitle>
                    <DialogDescription>You stopped “{description}”. Tick it off in your notes?</DialogDescription>
                </DialogHeader>
                <Pressable
                    onPress={() => setAlways((a) => !a)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: always }}
                    className="flex-row items-center gap-2.5 py-1"
                >
                    <View className={cn('size-[18px] items-center justify-center rounded-[4px] border', always ? 'border-foreground bg-foreground' : 'border-ring')}>
                        {always ? <Icon as={Check} className="size-3 text-background" /> : null}
                    </View>
                    <Text className="text-sm text-muted-foreground">Always tick off to-dos when I stop them</Text>
                </Pressable>
                <DialogFooter>
                    <Button variant="ghost" onPress={() => onAnswer(false, false)}>
                        <Text>Not yet</Text>
                    </Button>
                    <Button onPress={() => onAnswer(true, always)}>
                        <Text>Mark done</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
