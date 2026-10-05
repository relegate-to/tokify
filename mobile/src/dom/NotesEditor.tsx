'use dom';

import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { DOMProps } from 'expo/dom';
import { useEffect, useRef } from 'react';

import './sketchpad.css';
import './notes.css';

// The desktop's activity-notes editor (RichTextEditor without the toolbar):
// the same constrained HTML, so notes written on either side keep their
// formatting. Markdown-style shortcuts (- , [] , ##) do the formatting.

const escapeHTML = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Notes written before they were rich (plain lines) become paragraphs, as the
// desktop's editorHTML does on the way in.
function editorHTML(value: string) {
    if (!value.trim()) return '';
    if (/<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|br|strong|em|u|s|a|code)\b/i.test(value)) return value;
    return value
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `<p>${escapeHTML(l)}</p>`)
        .join('');
}

export default function NotesEditor({
    value,
    placeholder,
    theme,
    onChange,
}: {
    value: string;
    placeholder: string;
    theme: Record<string, string>;
    onChange: (html: string) => Promise<void>;
    dom?: DOMProps;
}) {
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const editor = useEditor({
        extensions: [
            StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
            TaskList,
            TaskItem.configure({ nested: true }),
            Placeholder.configure({ placeholder }),
        ],
        content: editorHTML(value),
        shouldRerenderOnTransaction: false,
        editorProps: { attributes: { class: 'rich-editor-prose', 'aria-label': 'Activity notes', spellcheck: 'true' } },
        onUpdate: ({ editor: next }) => {
            const html = next.getHTML();
            onChangeRef.current(html === '<p></p>' ? '' : html);
        },
    });

    useEffect(() => {
        const root = document.documentElement.style;
        for (const [name, color] of Object.entries(theme)) root.setProperty(`--${name}`, color);
    }, [theme]);

    return (
        <EditorContent
            editor={editor}
            className="rich-editor-scroll notes-editor"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    event.preventDefault();
                    editor?.commands.focus('end');
                }
            }}
        />
    );
}
