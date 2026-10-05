'use dom';

import { Node } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { DOMSerializer, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ViewMutationRecord } from '@tiptap/pm/view';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { DOMImperativeFactory, DOMProps } from 'expo/dom';
import { useDOMImperativeHandle } from 'expo/dom';
import { useCallback, useEffect, useMemo, useRef, type Ref } from 'react';

import './sketchpad.css';

// The desktop sketchpad's editor (RichTextEditor.tsx with SketchpadView's
// settings), run in a web view so the pad keeps the same document model and
// HTML as the desktop. Keyboard shortcuts give way to the native toolbar,
// which drives the editor through the handle below.

export type StartTodo = { id: string; description: string; notes: string; project: string };

export type EditorState = {
    focused: boolean;
    task: boolean;
    bold: boolean;
    italic: boolean;
    heading: boolean;
    bullet: boolean;
    list: boolean;
};

export type EditorCommand = 'task' | 'bold' | 'italic' | 'heading' | 'bullet' | 'sink' | 'lift' | 'undo' | 'redo' | 'blur';

export type SketchpadHandle = {
    run: (command: EditorCommand) => void;
    insertProject: (project: string) => void;
};

// The desktop's NoteProject node (NoteProjects.ts).
const NoteProject = Node.create({
    name: 'noteProject',
    group: 'block',
    atom: true,
    addAttributes: () => ({ project: { default: '', parseHTML: (element) => element.getAttribute('data-notes-project') ?? '' } }),
    parseHTML: () => [{ tag: 'div[data-notes-project]' }],
    renderHTML: ({ node }) => ['div', { 'data-notes-project': node.attrs.project, class: 'note-project' }, node.attrs.project || 'No project'],
});

// The first line of a to-do names the activity; lines after a soft break
// become its notes.
function todoText(item: ProseMirrorNode) {
    const lines: ProseMirrorNode[][] = [[]];
    item.firstChild?.forEach((child) => {
        if (child.type.name === 'hardBreak') lines.push([]);
        else lines[lines.length - 1].push(child);
    });
    const [first, ...rest] = lines;
    const { schema } = item.type;
    const serializer = DOMSerializer.fromSchema(schema);
    const notes = rest
        .filter((line) => line.some((child) => child.textContent.trim()))
        .map((line) => (serializer.serializeNode(schema.nodes.paragraph.create(null, line)) as HTMLElement).outerHTML)
        .join('');
    return { description: first.map((child) => child.textContent).join('').trim(), notes };
}

function outsideContent(contentDOM: HTMLElement | null | undefined) {
    return (mutation: ViewMutationRecord) => mutation.type !== 'selection' && !contentDOM?.contains(mutation.target);
}

function stateOf(editor: Editor, focused: boolean): EditorState {
    return {
        focused,
        task: editor.isActive('taskItem'),
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        heading: editor.isActive('heading', { level: 2 }),
        bullet: editor.isActive('bulletList'),
        list: editor.isActive('taskItem') || editor.isActive('listItem'),
    };
}

const FONTS: Record<string, unknown> = {
    400: require('@expo-google-fonts/instrument-sans/400Regular/InstrumentSans_400Regular.ttf'),
    500: require('@expo-google-fonts/instrument-sans/500Medium/InstrumentSans_500Medium.ttf'),
    600: require('@expo-google-fonts/instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf'),
};

// Metro's web bundle hands an asset back as its URL, or an object holding one.
function assetUrl(asset: unknown) {
    if (typeof asset === 'string') return asset;
    const a = asset as { uri?: string; default?: string };
    return a.uri ?? a.default ?? '';
}

export default function SketchpadEditor({
    value,
    theme,
    onChange,
    onStartTodo,
    onState,
    ref,
}: {
    value: string;
    theme: Record<string, string>;
    onChange: (html: string) => Promise<void>;
    onStartTodo: (todo: StartTodo) => Promise<void>;
    onState: (state: EditorState) => Promise<void>;
    ref?: Ref<SketchpadHandle>;
    dom?: DOMProps;
}) {
    const onChangeRef = useRef(onChange);
    const onStartTodoRef = useRef(onStartTodo);
    const onStateRef = useRef(onState);
    onChangeRef.current = onChange;
    onStartTodoRef.current = onStartTodo;
    onStateRef.current = onState;
    const lastValue = useRef(value);
    const lastState = useRef('');
    const pending = useRef<Editor | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flush = useCallback(() => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        const current = pending.current;
        pending.current = null;
        if (!current || current.isDestroyed) return;
        const html = current.getHTML();
        const next = html === '<p></p>' ? '' : html;
        lastValue.current = next;
        onChangeRef.current(next);
    }, []);

    const report = useCallback((editor: Editor) => {
        const state = stateOf(editor, editor.isFocused);
        const key = JSON.stringify(state);
        if (key === lastState.current) return;
        lastState.current = key;
        onStateRef.current(state);
    }, []);

    const extensions = useMemo(
        () => [
            NoteProject,
            StarterKit.configure({
                heading: { levels: [1, 2, 3] },
                link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
            }),
            TaskList,
            TaskItem.extend({
                addAttributes() {
                    return {
                        ...this.parent?.(),
                        todoId: {
                            default: null,
                            keepOnSplit: false,
                            parseHTML: (element) => element.getAttribute('data-todo-id'),
                            renderHTML: (attributes) => (attributes.todoId ? { 'data-todo-id': attributes.todoId } : {}),
                        },
                    };
                },
                addNodeView() {
                    const parent = this.parent?.();
                    if (!parent) return null;
                    return (props) => {
                        const view = parent(props);
                        const ignoreMutation = outsideContent(view.contentDOM);
                        let node = props.node;
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.contentEditable = 'false';
                        button.className = 'rich-editor-start-todo';
                        button.textContent = 'Start →';
                        const description = () => todoText(node).description;
                        const sync = () => {
                            button.hidden = Boolean(node.attrs.checked) || !description();
                            button.setAttribute('aria-label', `Start activity: ${description()}`);
                        };
                        sync();
                        button.onmousedown = (event) => event.preventDefault();
                        button.ontouchstart = (event) => event.stopPropagation();
                        button.onclick = async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (button.disabled || node.attrs.checked || !description()) return;
                            button.disabled = true;
                            try {
                                let project = '';
                                const position = props.getPos();
                                if (typeof position !== 'number') return;
                                props.editor.state.doc.forEach((block, offset) => {
                                    if (offset < position && block.type.name === 'noteProject') project = block.attrs.project;
                                });
                                let id: string | null = node.attrs.todoId;
                                if (!id) {
                                    id = crypto.randomUUID();
                                    props.editor.view.dispatch(props.editor.state.tr.setNodeAttribute(position, 'todoId', id).setMeta('addToHistory', false));
                                }
                                flush();
                                props.editor.commands.blur();
                                await onStartTodoRef.current({ id, project, ...todoText(node) });
                            } finally {
                                button.disabled = false;
                            }
                        };
                        view.dom.appendChild(button);
                        return {
                            ...view,
                            update: (updatedNode, decorations, innerDecorations) => {
                                if (!view.update?.(updatedNode, decorations, innerDecorations)) return false;
                                node = updatedNode;
                                sync();
                                return true;
                            },
                            stopEvent: (event) => button.contains(event.target as globalThis.Node) || view.stopEvent?.(event) || false,
                            ignoreMutation,
                        };
                    };
                },
            }).configure({ nested: true }),
            Placeholder.configure({ placeholder: 'Start writing…' }),
        ],
        [flush],
    );

    const editor = useEditor({
        extensions,
        content: value,
        shouldRerenderOnTransaction: false,
        editorProps: { attributes: { class: 'rich-editor-prose', 'aria-label': 'Notes', spellcheck: 'true' } },
        onUpdate: ({ editor: next }) => {
            pending.current = next;
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(flush, 250);
        },
        onTransaction: ({ editor: next }) => report(next),
        onFocus: ({ editor: next }) => report(next),
        onBlur: ({ editor: next }) => {
            flush();
            report(next);
        },
    });

    // The native side changes the pad only to tick off a finished to-do.
    useEffect(() => {
        if (!editor || value === lastValue.current) return;
        if (timer.current !== null) clearTimeout(timer.current);
        pending.current = null;
        lastValue.current = value;
        editor.commands.setContent(value, { emitUpdate: false });
    }, [editor, value]);

    useEffect(() => {
        const onHide = () => document.visibilityState === 'hidden' && flush();
        document.addEventListener('visibilitychange', onHide);
        return () => {
            flush();
            document.removeEventListener('visibilitychange', onHide);
        };
    }, [flush]);

    useEffect(() => {
        const root = document.documentElement.style;
        for (const [name, color] of Object.entries(theme)) root.setProperty(`--${name}`, color);
    }, [theme]);

    useEffect(() => {
        for (const [weight, asset] of Object.entries(FONTS)) {
            new FontFace('Instrument Sans', `url(${assetUrl(asset)})`, { weight }).load().then((face) => document.fonts.add(face), () => undefined);
        }
    }, []);

    // The bridge types handle methods as taking any JSON; these take strings.
    useDOMImperativeHandle(
        ref as unknown as Ref<DOMImperativeFactory>,
        () =>
            ({
            run: (command: EditorCommand) => {
                if (!editor) return;
                if (command === 'blur') return void editor.commands.blur();
                const chain = editor.chain().focus();
                const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
                const actions: Record<EditorCommand, () => typeof chain> = {
                    task: () => chain.toggleTaskList(),
                    bold: () => chain.toggleBold(),
                    italic: () => chain.toggleItalic(),
                    heading: () => chain.toggleHeading({ level: 2 }),
                    bullet: () => chain.toggleBulletList(),
                    sink: () => chain.sinkListItem(item),
                    lift: () => chain.liftListItem(item),
                    undo: () => chain.undo(),
                    redo: () => chain.redo(),
                    blur: () => chain,
                };
                actions[command]?.().run();
            },
            // As the desktop's project picker: the chosen project starts a
            // section after the current block, or replaces it when it's empty.
            insertProject: (project: string) => {
                if (!editor) return;
                const { $from, from } = editor.state.selection;
                let range = { from, to: from };
                if ($from.depth > 0) {
                    const block = $from.node(1);
                    const empty = block.type.name === 'paragraph' && block.content.size === 0;
                    range = empty ? { from: $from.before(1), to: $from.after(1) } : { from: $from.after(1), to: $from.after(1) };
                }
                editor.chain().focus().insertContentAt(range, [{ type: 'noteProject', attrs: { project } }, { type: 'paragraph' }]).run();
            },
            }) satisfies SketchpadHandle as unknown as DOMImperativeFactory,
        [editor],
    );

    return (
        <EditorContent
            editor={editor}
            className="rich-editor-scroll"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    event.preventDefault();
                    editor?.commands.focus('end');
                }
            }}
        />
    );
}
