import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mergeSketchpad } from './sketchpad-merge';

type Vector = { name: string; base: string; ours: string; theirs: string; want: string };

const vectors = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../internal/app/sketchpad/testdata/merge-vectors.json', import.meta.url)), 'utf8'),
) as Vector[];

describe('sketchpad merge, as the desktop merges', () => {
    it.each(vectors.map((v) => [v.name, v] as const))('%s', (_, v) => {
        expect(mergeSketchpad(v.base, v.ours, v.theirs)).toBe(v.want);
    });

    it('reproduces documents it does not change', () => {
        const doc = '<ul><li><p>Bullet</p><ul><li><p>Nested</p></li></ul><p>After</p></li></ul><pre><code>a &lt;p&gt;</code></pre><hr>';
        expect(mergeSketchpad(doc, '<p>lead</p>' + doc, doc + '<p>tail</p>')).toBe('<p>lead</p>' + doc + '<p>tail</p>');
    });
});
