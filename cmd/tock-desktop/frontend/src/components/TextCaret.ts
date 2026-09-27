import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

// WebKit sizes the caret on a wrapped line from the bottom of the line above,
// so with generous line-height it stretches to the whole line box on every
// wrapped line but stays text-height on the first. TextCaret hides the native
// caret (see .rich-editor-prose in style.css) and draws one the height of the
// text at the cursor, the same on every line.
export const TextCaret = Extension.create({
    name: 'textCaret',
    addProseMirrorPlugins() {
        return [new Plugin({
            view: (view) => {
                const caret = document.createElement('div');
                caret.className = 'rich-editor-caret';
                caret.setAttribute('aria-hidden', 'true');
                caret.hidden = true;

                const place = () => placeCaret(view, caret);
                const placeSoon = () => requestAnimationFrame(place);
                const resize = new ResizeObserver(place);
                resize.observe(view.dom);
                view.dom.addEventListener('focus', placeSoon);
                view.dom.addEventListener('blur', place);
                window.addEventListener('resize', place);
                return {
                    update: place,
                    destroy: () => {
                        resize.disconnect();
                        view.dom.removeEventListener('focus', placeSoon);
                        view.dom.removeEventListener('blur', place);
                        window.removeEventListener('resize', place);
                        caret.remove();
                    },
                };
            },
        })];
    },
});

function placeCaret(view: EditorView, caret: HTMLDivElement) {
    // The editor DOM is mounted into EditorContent's element after the plugin
    // starts, so the caret joins it lazily. It sits beside the editor DOM,
    // never inside it, where ProseMirror would read it as content.
    const host = view.dom.parentElement;
    const { selection } = view.state;
    if (!host || !view.editable || view.composing || !selection.empty || !view.hasFocus()) {
        caret.hidden = true;
        return;
    }
    if (caret.parentElement !== host) host.append(caret);

    const at = view.coordsAtPos(selection.head);
    // An empty line has no glyph to measure and reports its whole line box, so
    // cap the height at the font's and centre it where the text would sit.
    const { node } = view.domAtPos(selection.head);
    const element = node instanceof Element ? node : node.parentElement;
    const fontSize = element ? parseFloat(getComputedStyle(element).fontSize) : 16;
    const height = Math.min(at.bottom - at.top, fontSize * 1.2);
    const top = (at.top + at.bottom - height) / 2;

    const box = host.getBoundingClientRect();
    caret.hidden = false;
    caret.style.height = `${height}px`;
    caret.style.transform = `translate(${at.left - box.left + host.scrollLeft}px, ${top - box.top + host.scrollTop}px)`;
    // Restart the blink so the caret stays solid while it moves.
    for (const animation of caret.getAnimations()) animation.currentTime = 0;
}
