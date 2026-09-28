import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { DOMSerializer, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ViewMutationRecord } from '@tiptap/pm/view';
import {
    Bold,
    Heading2,
    Italic,
    Link2,
    List,
    ListOrdered,
    ListTodo,
    Redo2,
    Undo2,
} from 'lucide-react';

import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { cn } from '@/lib/utils';
import { NoteProject, projectPicker } from '@/components/NoteProjects';
import { TextCaret } from '@/components/TextCaret';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

function escapeHTML(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function legacyInline(value: string) {
    return escapeHTML(value)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/~~([^~]+)~~/g, '<s>$1</s>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

// Notes used to be plain text/Markdown. Convert that once on the way into the
// rich editor; all newly edited notes are stored as constrained semantic HTML.
function legacyNotesToHTML(value: string) {
    const lines = value.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            index += 1;
            continue;
        }

        if (/^\s*```/.test(line)) {
            const code: string[] = [];
            index += 1;
            while (index < lines.length && !/^\s*```/.test(lines[index])) {
                code.push(lines[index]);
                index += 1;
            }
            if (index < lines.length) index += 1;
            html.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
            continue;
        }

        const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
        if (heading) {
            html.push(`<h${heading[1].length}>${legacyInline(heading[2])}</h${heading[1].length}>`);
            index += 1;
            continue;
        }

        const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (task) {
            const items: string[] = [];
            while (index < lines.length) {
                const match = lines[index].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
                if (!match) break;
                items.push(`<li data-type="taskItem" data-checked="${match[1].toLowerCase() === 'x'}"><p>${legacyInline(match[2])}</p></li>`);
                index += 1;
            }
            html.push(`<ul data-type="taskList">${items.join('')}</ul>`);
            continue;
        }

        const list = line.match(/^\s*(?:(\d+)[.)]|[-*+])\s+(.*)$/);
        if (list) {
            const ordered = Boolean(list[1]);
            const items: string[] = [];
            while (index < lines.length) {
                const match = lines[index].match(/^\s*(?:(\d+)[.)]|[-*+])\s+(.*)$/);
                if (!match || Boolean(match[1]) !== ordered) break;
                items.push(`<li><p>${legacyInline(match[2])}</p></li>`);
                index += 1;
            }
            const tag = ordered ? 'ol' : 'ul';
            html.push(`<${tag}>${items.join('')}</${tag}>`);
            continue;
        }

        if (/^\s*>/.test(line)) {
            const quote: string[] = [];
            while (index < lines.length && /^\s*>/.test(lines[index])) {
                quote.push(legacyInline(lines[index].replace(/^\s*>\s?/, '')));
                index += 1;
            }
            html.push(`<blockquote><p>${quote.join('<br>')}</p></blockquote>`);
            continue;
        }

        const paragraph: string[] = [];
        while (
            index < lines.length &&
            lines[index].trim() &&
            !/^\s*(?:#{1,3}\s+|```|>|(?:\d+[.)]|[-*+])\s+)/.test(lines[index])
        ) {
            paragraph.push(legacyInline(lines[index]));
            index += 1;
        }
        html.push(`<p>${paragraph.join('<br>')}</p>`);
    }

    return html.join('');
}

function editorHTML(value: string) {
    if (!value.trim()) return '';
    if (value.includes('data-notes-project') || /<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|br|strong|em|u|s|a|code)\b/i.test(value)) {
        return value;
    }
    return legacyNotesToHTML(value);
}

function normalizedLink(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^(?:https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
    return `https://${trimmed}`;
}

function ToolButton({
    active = false,
    disabled = false,
    label,
    onClick,
    children,
}: {
    active?: boolean;
    disabled?: boolean;
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
            className={cn('rich-editor-tool', active && 'is-active')}
        >
            {children}
        </button>
    );
}

export type StartTodo = {
    id: string;
    description: string;
    notes: string;
    project: string;
};

// The first line of a to-do names the activity; lines after a soft break
// (Shift+Enter) become its notes.
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
        .map((line) => {
            const paragraph = serializer.serializeNode(schema.nodes.paragraph.create(null, line));
            return (paragraph as HTMLElement).outerHTML;
        })
        .join('');
    return { description: first.map((child) => child.textContent).join('').trim(), notes };
}

// TipTap's task item rewrites its checkbox label on every update without
// ignoring the mutation. ProseMirror then re-reads the selection from the DOM,
// which drops pending marks, so Cmd+B mid-line inside a to-do did nothing.
function outsideContent(contentDOM: HTMLElement | null | undefined) {
    return (mutation: ViewMutationRecord) => mutation.type !== 'selection' && !contentDOM?.contains(mutation.target);
}

export const RichTextEditor = memo(function RichTextEditor({
    value,
    onValueChange,
    className,
    contentClassName,
    placeholder = 'Write…',
    ariaLabel = 'Rich text editor',
    updateDelay = 0,
    showToolbar = false,
    onStartTodo,
    projects,
}: {
    value: string;
    onValueChange: (value: string) => void;
    className?: string;
    contentClassName?: string;
    placeholder?: string;
    ariaLabel?: string;
    updateDelay?: number;
    showToolbar?: boolean;
    onStartTodo?: (todo: StartTodo) => Promise<unknown>;
    projects?: string[];
}) {
    const onValueChangeRef = useRef(onValueChange);
    const onStartTodoRef = useRef(onStartTodo);
    const projectsRef = useRef(projects);
    projectsRef.current = projects;
    const hasProjects = projects !== undefined;
    const initialContent = useRef<string | undefined>(undefined);
    if (initialContent.current === undefined) initialContent.current = editorHTML(value);
    const lastValue = useRef(value);
    const pending = useRef<Editor | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        onValueChangeRef.current = onValueChange;
        onStartTodoRef.current = onStartTodo;
    }, [onValueChange, onStartTodo]);

    const flush = useCallback(() => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        const current = pending.current;
        pending.current = null;
        if (!current || current.isDestroyed) return;
        const html = current.getHTML();
        // An empty checklist or heading is meaningful editing state.
        const next = html === '<p></p>' ? '' : html;
        lastValue.current = next;
        onValueChangeRef.current(next);
    }, []);

    const extensions = useMemo(
        () => [
            NoteProject,
            TextCaret,
            ...(hasProjects ? [projectPicker(() => projectsRef.current ?? [])] : []),
            StarterKit.configure({
                heading: { levels: [1, 2, 3] },
                link: {
                    openOnClick: false,
                    autolink: true,
                    defaultProtocol: 'https',
                    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
                },
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
                            renderHTML: (attributes) => attributes.todoId ? { 'data-todo-id': attributes.todoId } : {},
                        },
                    };
                },
                addNodeView() {
                    const parent = this.parent?.();
                    if (!parent) return null;
                    return (props) => {
                        const view = parent(props);
                        const ignoreMutation = outsideContent(view.contentDOM);
                        if (!onStartTodoRef.current) return { ...view, ignoreMutation };
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
                                // A stable id lets the to-do be ticked off when its activity stops.
                                let id: string | null = node.attrs.todoId;
                                if (!id) {
                                    id = crypto.randomUUID();
                                    props.editor.view.dispatch(props.editor.state.tr
                                        .setNodeAttribute(position, 'todoId', id)
                                        .setMeta('addToHistory', false));
                                }
                                flush();
                                await onStartTodoRef.current?.({ id, project, ...todoText(node) });
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
                            stopEvent: (event) => button.contains(event.target as Node) || view.stopEvent?.(event) || false,
                            ignoreMutation,
                        };
                    };
                },
                addKeyboardShortcuts() {
                    return {
                        ...this.parent?.(),
                        'Mod-Enter': () => {
                            if (!this.editor.isActive('taskItem')) return this.editor.commands.toggleTaskList();
                            return this.editor.commands.updateAttributes('taskItem', {
                                checked: !this.editor.getAttributes('taskItem').checked,
                            });
                        },
                    };
                },
            }).configure({ nested: true }),
            Placeholder.configure({ placeholder }),
        ],
        [placeholder, flush, hasProjects],
    );

    const editor: Editor | null = useEditor({
        extensions,
        content: initialContent.current,
        shouldRerenderOnTransaction: false,
        editorProps: {
            attributes: {
                class: 'rich-editor-prose',
                'aria-label': ariaLabel,
                spellcheck: 'true',
            },
            handleKeyDown: (view, event) => {
                if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return false;
                const current = editor;
                if (!current) return false;
                const item = current.isActive('taskItem') ? 'taskItem'
                    : current.isActive('listItem') ? 'listItem' : null;
                if (item) {
                    if (event.shiftKey) current.commands.liftListItem(item);
                    else current.commands.sinkListItem(item);
                    return true;
                }
                const { $from } = view.state.selection;
                if (!event.shiftKey) view.dispatch(view.state.tr.insertText('\t'));
                else if ($from.parent.textContent.startsWith('\t')) {
                    view.dispatch(view.state.tr.delete($from.start(), $from.start() + 1));
                }
                return true;
            },
            handleDOMEvents: {
                click: (_view, event) => {
                    const link = (event.target as HTMLElement | null)?.closest('a[href]');
                    if (!link || event.button !== 0 || !window.getSelection()?.isCollapsed) return false;
                    event.preventDefault();
                    BrowserOpenURL(link.getAttribute('href') ?? '');
                    return true;
                },
            },
        },
        onUpdate: ({ editor: nextEditor }) => {
            pending.current = nextEditor;
            if (timer.current !== null) clearTimeout(timer.current);
            if (updateDelay) timer.current = setTimeout(flush, updateDelay);
            else flush();
        },
        onBlur: flush,
    });

    useEffect(() => {
        if (!editor || value === lastValue.current) return;
        if (timer.current !== null) clearTimeout(timer.current);
        pending.current = null;
        lastValue.current = value;
        editor.commands.setContent(editorHTML(value), { emitUpdate: false });
    }, [editor, value]);

    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        window.addEventListener('pagehide', flush);
        window.addEventListener('blur', flush);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            flush();
            window.removeEventListener('pagehide', flush);
            window.removeEventListener('blur', flush);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [flush]);

    return (
        <div className={cn('rich-text-editor swiper-no-swiping', className)}
            onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                    event.stopPropagation();
                }
            }}>
            {showToolbar && <EditorToolbar editor={editor} />}
            <EditorContent editor={editor} className={cn('rich-editor-scroll', contentClassName)}
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                        event.preventDefault();
                        editor?.commands.focus('end');
                    }
                }} />
        </div>
    );
});

const EditorToolbar = memo(function EditorToolbar({ editor }: { editor: Editor | null }) {
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkValue, setLinkValue] = useState('');
    const state = useEditorState({
        editor,
        selector: ({ editor: current }) => ({
            bold: current?.isActive('bold') ?? false,
            italic: current?.isActive('italic') ?? false,
            heading: current?.isActive('heading', { level: 2 }) ?? false,
            bullet: current?.isActive('bulletList') ?? false,
            ordered: current?.isActive('orderedList') ?? false,
            task: current?.isActive('taskList') ?? false,
            link: current?.isActive('link') ?? false,
            canUndo: current?.can().undo() ?? false,
            canRedo: current?.can().redo() ?? false,
        }),
    });

    const editLink = (open: boolean) => {
        setLinkOpen(open);
        if (open && editor) setLinkValue(editor.getAttributes('link').href ?? '');
    };

    const applyLink = () => {
        if (!editor) return;
        const href = normalizedLink(linkValue);
        if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
        else editor.chain().focus().extendMarkRange('link').unsetLink().run();
        setLinkOpen(false);
    };

    const inactive = !editor;
    return (
            <div className="rich-editor-toolbar" role="toolbar" aria-label="Text formatting">
                <button type="button" className={cn('rich-editor-tool rich-editor-todo', state?.task && 'is-active')}
                    aria-label="Checklist" aria-pressed={state?.task} disabled={inactive}
                    title="Checklist (⌘⇧9)" onMouseDown={(event) => event.preventDefault()}
                    onClick={() => editor?.chain().focus().toggleTaskList().run()}>
                    <ListTodo /><span>To-do</span>
                </button>
                <span className="rich-editor-divider" aria-hidden />
                <div className="rich-editor-tool-group">
                    <ToolButton label="Bold" active={state?.bold} disabled={inactive} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold /></ToolButton>
                    <ToolButton label="Italic" active={state?.italic} disabled={inactive} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic /></ToolButton>
                </div>
                <span className="rich-editor-divider" aria-hidden />
                <div className="rich-editor-tool-group">
                    <ToolButton label="Heading" active={state?.heading} disabled={inactive} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolButton>
                    <ToolButton label="Bulleted list" active={state?.bullet} disabled={inactive} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List /></ToolButton>
                    <ToolButton label="Numbered list" active={state?.ordered} disabled={inactive} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolButton>
                </div>
                <span className="rich-editor-divider" aria-hidden />
                <div className="rich-editor-tool-group">
                    <Popover open={linkOpen} onOpenChange={editLink}>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className={cn('rich-editor-tool', state?.link && 'is-active')}
                                aria-label="Link"
                                aria-pressed={state?.link}
                                title="Link"
                                disabled={inactive}
                                onMouseDown={(event) => event.preventDefault()}
                            >
                                <Link2 />
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-72" onCloseAutoFocus={(event) => {
                            event.preventDefault();
                            editor?.commands.focus();
                        }}>
                            <form
                                className="flex items-center gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    applyLink();
                                }}
                            >
                                <Input
                                    autoFocus
                                    value={linkValue}
                                    onChange={(event) => setLinkValue(event.target.value)}
                                    placeholder="example.com"
                                    aria-label="Link address"
                                />
                                <Button type="submit" size="sm">Apply</Button>
                            </form>
                            {state?.link && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="self-start text-muted-foreground"
                                    onClick={() => {
                                        editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                                        setLinkOpen(false);
                                    }}
                                >
                                    Remove link
                                </Button>
                            )}
                        </PopoverContent>
                    </Popover>
                </div>
                <span className="rich-editor-toolbar-spacer" />
                <div className="rich-editor-tool-group">
                    <ToolButton label="Undo note edit" disabled={!state?.canUndo} onClick={() => editor?.chain().focus().undo().run()}><Undo2 /></ToolButton>
                    <ToolButton label="Redo note edit" disabled={!state?.canRedo} onClick={() => editor?.chain().focus().redo().run()}><Redo2 /></ToolButton>
                </div>
            </div>
    );
});
