import { useCallback, useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';

import { RichTextEditor, type StartTodo } from '@/components/RichTextEditor';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const SKETCHPAD_KEY = 'tokify.sketchpad';
const TODO_RUNS_KEY = 'tokify.todoRuns';

function readSketchpad() {
    try {
        return localStorage.getItem(SKETCHPAD_KEY) ?? '';
    } catch {
        return '';
    }
}

const sketchpadListeners = new Set<(text: string) => void>();

// completeSketchpadTodo ticks off a to-do by id, whether or not the pad is open.
export function completeSketchpadTodo(id: string) {
    const doc = new DOMParser().parseFromString(readSketchpad(), 'text/html');
    const item = doc.querySelector(`li[data-type="taskItem"][data-todo-id="${CSS.escape(id)}"]`);
    if (!item) return false;
    item.setAttribute('data-checked', 'true');
    item.querySelector(':scope > label > input')?.setAttribute('checked', 'checked');
    const text = doc.body.innerHTML;
    try {
        localStorage.setItem(SKETCHPAD_KEY, text);
    } catch {
        // The open pad still shows the change for this session.
    }
    sketchpadListeners.forEach((listener) => listener(text));
    return true;
}

// A todo run links an activity (by start time) to the to-do it was started from.
export type TodoRun = { start: string; id: string; description: string };

export function readTodoRuns(): TodoRun[] {
    try {
        const runs = JSON.parse(localStorage.getItem(TODO_RUNS_KEY) ?? '[]');
        return Array.isArray(runs) ? runs : [];
    } catch {
        return [];
    }
}

export function writeTodoRuns(runs: TodoRun[]) {
    try {
        localStorage.setItem(TODO_RUNS_KEY, JSON.stringify(runs));
    } catch {
        // Without storage, stopping simply won't offer to tick the to-do.
    }
}

export function SketchpadView({ onStartTodo, projects }: { onStartTodo?: (todo: StartTodo) => Promise<unknown>; projects?: string[] }) {
    const [text, setText] = useState(readSketchpad);

    useEffect(() => {
        sketchpadListeners.add(setText);
        return () => {
            sketchpadListeners.delete(setText);
        };
    }, []);

    const saveText = useCallback((text: string) => {
        try {
            localStorage.setItem(SKETCHPAD_KEY, text);
        } catch {
            // The pad remains usable for this session if local storage is unavailable.
        }
    }, []);

    return (
        <section className="flex min-h-full flex-1 flex-col">
            <div className="mx-auto flex min-h-full w-full max-w-[620px] flex-1 flex-col">
                <div className="order-last flex justify-end pt-3">
                    <Popover>
                        <PopoverTrigger asChild>
                            <button type="button" aria-label="Notes keyboard shortcuts"
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                                <Keyboard className="size-3.5" /><span>Shortcuts</span>
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-72 gap-4 p-4">
                            <p className="text-xs font-medium">Keep your hands on the keyboard</p>
                            <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2.5 text-xs">
                                {[
                                    ['To-do / complete', '⌘ Enter'],
                                    ['Notes for a to-do', '⇧ Enter'],
                                    ['Choose a project', '⌘ P'],
                                    ['Bold', '⌘ B'],
                                    ['Italic', '⌘ I'],
                                    ['Indent / outdent list', 'Tab / ⇧ Tab'],
                                    ['Undo / redo', '⌘ Z / ⌘ ⇧ Z'],
                                ].map(([label, keys]) => <div key={label} className="contents">
                                    <dt className="text-muted-foreground">{label}</dt>
                                    <dd className="text-right"><kbd className="font-sans">{keys}</kbd></dd>
                                </div>)}
                            </dl>
                            <p className="border-t border-border pt-3 text-xs leading-6 text-muted-foreground">
                                Press <kbd>⌘ P</kbd> to start a project section. To-dos below use that project. Choose No project to end a project section.
                            </p>
                            <p className="text-xs leading-6 text-muted-foreground">
                                At the start of a line, type <kbd>[]</kbd> for a to-do, <kbd>-</kbd> for a list, or <kbd>##</kbd> for a heading, then Space. Enter twice leaves a list.
                            </p>
                        </PopoverContent>
                    </Popover>
                </div>
                <div className="flex flex-1 flex-col">
                    <RichTextEditor
                        className="rich-editor-document flex-1"
                        contentClassName="min-h-72 text-[17px] leading-8 tracking-[-0.01em]"
                        value={text}
                        onValueChange={saveText}
                        updateDelay={250}
                        showToolbar={false}
                        onStartTodo={onStartTodo}
                        projects={projects}
                        placeholder="Start writing…"
                        ariaLabel="Notes"
                    />
                </div>
            </div>
        </section>
    );
}
