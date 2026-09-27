import { Extension, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const NoteProject = Node.create({
    name: 'noteProject',
    group: 'block',
    atom: true,
    addAttributes: () => ({ project: { default: '', parseHTML: element => element.getAttribute('data-notes-project') ?? '' } }),
    parseHTML: () => [{ tag: 'div[data-notes-project]' }],
    renderHTML: ({ node }) => ['div', { 'data-notes-project': node.attrs.project, class: 'note-project' }, node.attrs.project || 'No project'],
});

// projectPicker opens a filterable project menu on Mod-p. The chosen project
// starts a section after the current block, or replaces it when it's empty.
export function projectPicker(getProjects: () => string[]) {
    return Extension.create({
        name: 'noteProjectPicker',
        addStorage: () => ({ open: () => {} }),
        addKeyboardShortcuts() {
            return {
                'Mod-p': () => {
                    this.storage.open();
                    return true;
                },
            };
        },
        addProseMirrorPlugins() {
            const editor = this.editor;
            const storage = this.storage;
            let menu: HTMLDivElement;
            let input: HTMLInputElement;
            let list: HTMLDivElement;
            let target: { from: number; to: number; cursor: number } | null = null;
            let choices: string[] = [];
            let selected = 0;
            const close = (refocus: boolean) => {
                if (!target) return;
                const { cursor } = target;
                target = null;
                menu.hidden = true;
                if (refocus) editor.chain().focus().setTextSelection(cursor).run();
            };
            const choose = (project: string) => {
                if (!target) return;
                const range = { from: target.from, to: target.to };
                target = null;
                menu.hidden = true;
                editor.chain().focus().insertContentAt(range, [
                    { type: 'noteProject', attrs: { project } },
                    { type: 'paragraph' },
                ]).run();
            };
            const paint = () => {
                const query = input.value.trim().toLowerCase();
                choices = [...new Set(getProjects())].filter(project => project.toLowerCase().includes(query)).slice(0, 8);
                if (!query || 'no project'.includes(query)) choices.push('');
                selected = Math.min(selected, Math.max(0, choices.length - 1));
                list.replaceChildren();
                choices.forEach((project, index) => {
                    const option = document.createElement('button');
                    option.type = 'button';
                    option.tabIndex = -1;
                    option.setAttribute('role', 'option');
                    option.setAttribute('aria-selected', String(index === selected));
                    option.textContent = project || 'No project';
                    option.onmousedown = event => event.preventDefault();
                    option.onclick = () => choose(project);
                    list.append(option);
                });
                if (!choices.length) list.textContent = 'No matching projects';
            };
            storage.open = () => {
                const { $from, from } = editor.state.selection;
                if ($from.depth === 0) {
                    target = { from, to: from, cursor: from };
                } else {
                    const block = $from.node(1);
                    const empty = block.type.name === 'paragraph' && block.content.size === 0;
                    target = empty
                        ? { from: $from.before(1), to: $from.after(1), cursor: from }
                        : { from: $from.after(1), to: $from.after(1), cursor: from };
                }
                input.value = '';
                selected = 0;
                paint();
                menu.hidden = false;
                const rect = editor.view.coordsAtPos(from);
                menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`;
                menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight + 8 > window.innerHeight ? rect.top - menu.offsetHeight - 8 : rect.bottom + 8)}px`;
                input.focus();
            };
            return [new Plugin({
                view: () => {
                    menu = document.createElement('div');
                    menu.className = 'note-project-options';
                    menu.hidden = true;
                    input = document.createElement('input');
                    input.placeholder = 'Project…';
                    input.setAttribute('aria-label', 'Filter projects');
                    input.setAttribute('aria-controls', 'note-project-list');
                    list = document.createElement('div');
                    list.id = 'note-project-list';
                    list.setAttribute('role', 'listbox');
                    list.setAttribute('aria-label', 'Projects');
                    menu.append(input, list);
                    input.oninput = () => {
                        selected = 0;
                        paint();
                    };
                    input.onkeydown = (event) => {
                        if (event.isComposing) return;
                        if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p')) {
                            event.preventDefault();
                            close(true);
                        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault();
                            selected = choices.length ? (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0;
                            paint();
                        } else if ((event.key === 'Enter' || event.key === 'Tab') && choices.length) {
                            event.preventDefault();
                            choose(choices[selected]);
                        }
                    };
                    document.body.append(menu);
                    const dismiss = (event: FocusEvent | MouseEvent) => {
                        if (!menu.contains(event.target as globalThis.Node)) close(false);
                    };
                    document.addEventListener('mousedown', dismiss);
                    document.addEventListener('focusin', dismiss);
                    return {
                        destroy: () => {
                            menu.remove();
                            document.removeEventListener('mousedown', dismiss);
                            document.removeEventListener('focusin', dismiss);
                        },
                    };
                },
            })];
        },
    });
}
