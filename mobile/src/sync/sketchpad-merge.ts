// The desktop's sketchpad merge (internal/app/sketchpad/merge.go), checked
// against its vectors in internal/app/sketchpad/testdata/merge-vectors.json.
//
// Two edits from a common base: edits to different blocks both apply. Where
// both touched the same blocks, ours stands and the blocks only theirs wrote
// are added after it, so a conflict can duplicate text but never drops what
// either device wrote.
export function mergeSketchpad(base: string, ours: string, theirs: string): string {
    if (ours === theirs || theirs === base) return ours;
    if (ours === base) return theirs;
    return render(merge3(lines(base), lines(ours), lines(theirs)));
}

// One line per leaf block, carrying its containers: written in full on the
// line that opens them, by bare name after (see merge.go).
const LEVEL = '\x00';
const LEAF = '\x01';
const OPENED = '+';

const CONTAINERS = new Set(['ul', 'ol', 'li', 'blockquote', 'div']);
const VOIDS = new Set(['br', 'hr', 'img', 'input', 'wbr']);

function lines(html: string): string[] {
    const out: string[] = [];
    const path: string[] = [];
    const stack: string[] = [];
    const fresh: boolean[] = [];
    const leaf = (text: string) => {
        out.push(line(path, fresh, text));
        fresh.fill(false);
    };
    for (let i = 0; i < html.length; ) {
        if (html[i] !== '<') {
            let j = html.indexOf('<', i);
            if (j < 0) j = html.length;
            leaf(html.slice(i, j));
            i = j;
            continue;
        }
        const end = tagEnd(html, i);
        const tag = html.slice(i, end);
        const [name, closing] = tagName(tag);
        if (closing && CONTAINERS.has(name)) {
            if (stack.length > 0 && stack[stack.length - 1] === name) {
                stack.pop();
                path.pop();
                fresh.pop();
            }
            i = end;
        } else if (!closing && CONTAINERS.has(name)) {
            let head = tag;
            i = end;
            if (name === 'li' && html.startsWith('<label', i)) {
                const close = closeOf(html, tagEnd(html, i), 'label');
                head += html.slice(i, close);
                i = close;
            }
            stack.push(name);
            path.push(head);
            fresh.push(true);
        } else {
            let close = end;
            if (!closing && !VOIDS.has(name) && !tag.endsWith('/>')) close = closeOf(html, end, name);
            leaf(html.slice(i, close));
            i = close;
        }
    }
    return out;
}

function line(path: string[], fresh: boolean[], leaf: string) {
    let s = '';
    path.forEach((head, i) => {
        s += (fresh[i] ? OPENED + head : tagName(head)[0]) + LEVEL;
    });
    return s + LEAF + leaf;
}

function render(ls: string[]) {
    let s = '';
    const stack: string[] = [];
    for (const l of ls) {
        const cut = l.indexOf(LEAF);
        const levels = l.slice(0, cut);
        const leaf = l.slice(cut + 1);
        const path = levels ? levels.slice(0, -1).split(LEVEL) : [];
        let keep = 0;
        while (keep < path.length && keep < stack.length && !path[keep].startsWith(OPENED) && path[keep] === stack[keep]) keep++;
        while (stack.length > keep) s += `</${stack.pop()}>`;
        for (const level of path.slice(keep)) {
            if (level.startsWith(OPENED)) {
                const head = level.slice(OPENED.length);
                s += head;
                stack.push(tagName(head)[0]);
            } else {
                s += `<${level}>`;
                stack.push(level);
            }
        }
        s += leaf;
    }
    while (stack.length > 0) s += `</${stack.pop()}>`;
    return s;
}

function tagEnd(s: string, i: number) {
    let quote = '';
    for (let j = i + 1; j < s.length; j++) {
        const c = s[j];
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') return j + 1;
    }
    return s.length;
}

function tagName(tag: string): [string, boolean] {
    let s = tag.startsWith('<') ? tag.slice(1) : tag;
    const closing = s.startsWith('/');
    if (closing) s = s.slice(1);
    const m = /^[a-zA-Z0-9-]*/.exec(s);
    return [(m?.[0] ?? '').toLowerCase(), closing];
}

function closeOf(s: string, from: number, name: string) {
    let depth = 1;
    for (let i = from; i < s.length; ) {
        const j = s.indexOf('<', i);
        if (j < 0) break;
        i = j;
        const end = tagEnd(s, i);
        const tag = s.slice(i, end);
        const [n, closing] = tagName(tag);
        if (n === name) {
            if (closing) depth--;
            else if (!tag.endsWith('/>')) depth++;
            if (depth === 0) return end;
        }
        i = end;
    }
    return s.length;
}

// base[b0:b1] replaced by side[s0:s1].
type Hunk = { b0: number; b1: number; s0: number; s1: number; theirs: boolean };

function merge3(base: string[], ours: string[], theirs: string[]): string[] {
    const hs = [...diff(base, ours, false), ...diff(base, theirs, true)];
    // Stable: an insertion goes before a change starting at the same place.
    hs.sort((a, b) => a.b0 - b.b0 || Math.min(a.b1 - a.b0, 1) - Math.min(b.b1 - b.b0, 1));

    const out: string[] = [];
    let pos = 0;
    for (let i = 0; i < hs.length; ) {
        const g0 = hs[i].b0;
        let g1 = hs[i].b1;
        let j = i + 1;
        while (j < hs.length && joins(hs[j], g0, g1)) {
            g1 = Math.max(g1, hs[j].b1);
            j++;
        }
        out.push(...base.slice(pos, g0));
        const group = hs.slice(i, j);
        out.push(...resolve(base.slice(g0, g1), side(base, ours, group, g0, g1, false), side(base, theirs, group, g0, g1, true)));
        pos = g1;
        i = j;
    }
    out.push(...base.slice(pos));
    return out;
}

function joins(h: Hunk, g0: number, g1: number) {
    return h.b0 < g1 || (g0 === g1 && h.b0 === g0 && h.b1 === h.b0);
}

function side(base: string[], ls: string[], group: Hunk[], g0: number, g1: number, theirs: boolean) {
    const out: string[] = [];
    let pos = g0;
    for (const h of group) {
        if (h.theirs !== theirs) continue;
        out.push(...base.slice(pos, h.b0), ...ls.slice(h.s0, h.s1));
        pos = h.b1;
    }
    out.push(...base.slice(pos, g1));
    return out;
}

const equal = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

function resolve(base: string[], ours: string[], theirs: string[]) {
    if (equal(ours, theirs) || equal(theirs, base)) return ours;
    if (equal(ours, base)) return theirs;
    const out = [...ours];
    for (const l of theirs) if (!base.includes(l) && !ours.includes(l)) out.push(l);
    return out;
}

const MAX_CELLS = 4_000_000;

function diff(a: string[], b: string[], theirs: boolean): Hunk[] {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const ma = a.slice(pre, a.length - suf);
    const mb = b.slice(pre, b.length - suf);
    const n = ma.length;
    const m = mb.length;
    if (n === 0 && m === 0) return [];
    if (n === 0 || m === 0 || n * m > MAX_CELLS) return [{ b0: pre, b1: pre + n, s0: pre, s1: pre + m, theirs }];
    // lcs[i*(m+1)+j] is the LCS length of ma[i:] and mb[j:].
    const lcs = new Int32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => lcs[i * (m + 1) + j];
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * (m + 1) + j] = ma[i] === mb[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
        }
    }
    const hs: Hunk[] = [];
    let i = 0;
    let j = 0;
    let ci = 0;
    let cj = 0;
    const flush = () => {
        if (ci < i || cj < j) hs.push({ b0: pre + ci, b1: pre + i, s0: pre + cj, s1: pre + j, theirs });
    };
    while (i < n && j < m) {
        if (ma[i] === mb[j]) {
            flush();
            i++;
            j++;
            ci = i;
            cj = j;
        } else if (at(i + 1, j) >= at(i, j + 1)) i++;
        else j++;
    }
    i = n;
    j = m;
    flush();
    return hs;
}
