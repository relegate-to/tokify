// FLIP for list removal.
//
// Animating a row's height closed makes the browser re-lay-out the scroll
// container on every frame, and the log keeps the whole history mounted, so that
// is hundreds of rows of layout per frame. Instead: let the DOM settle into its
// final layout in one pass, put everything that moved back where it was with a
// transform, then animate that transform away. Transforms run on the compositor,
// so the frames themselves cost no layout and no paint.

// Elements this far outside the viewport still animate, so a scroll arriving
// mid-animation doesn't reveal a row snapping into place at the edge.
const BUFFER_PX = 400;

export type FlipSnapshot = Map<string, number>;

const SELECTOR = '[data-flip-group], [data-flip-row]';

function flipId(el: HTMLElement): string | undefined {
    return el.dataset.flipGroup ?? el.dataset.flipRow;
}

// Records where everything is *before* the removal. Reading every row costs one
// layout pass in total, not one per element.
export function captureFlip(root: HTMLElement | null): FlipSnapshot {
    const snapshot: FlipSnapshot = new Map();
    if (!root) return snapshot;
    for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
        const id = flipId(el);
        if (id) snapshot.set(id, el.getBoundingClientRect().top);
    }
    return snapshot;
}

export function playFlip(
    root: HTMLElement | null,
    snapshot: FlipSnapshot,
    durationMs: number,
    easing: string,
): void {
    if (!root || snapshot.size === 0) return;

    const top = -BUFFER_PX;
    const bottom = window.innerHeight + BUFFER_PX;
    const moved: { el: HTMLElement; delta: number }[] = [];

    const consider = (el: HTMLElement) => {
        const id = flipId(el);
        if (!id) return;
        const before = snapshot.get(id);
        if (before === undefined) return;
        const rect = el.getBoundingClientRect();
        const delta = before - rect.top;
        if (Math.abs(delta) < 0.5) return;
        // Only what someone could actually see needs animating. Transforming the
        // off-screen remainder of the history would promote hundreds of elements
        // to their own compositor layers for nothing.
        if (rect.bottom < top || rect.top > bottom) return;
        moved.push({ el, delta });
    };

    // Groups first: a group that moves carries its own rows with it, so those
    // rows must not also be transformed or they travel twice.
    const groups = root.querySelectorAll<HTMLElement>('[data-flip-group]');
    for (const group of groups) {
        const seen = moved.length;
        consider(group);
        if (moved.length > seen) group.dataset.flipMoving = '1';
    }
    for (const row of root.querySelectorAll<HTMLElement>('[data-flip-row]')) {
        if (row.closest<HTMLElement>('[data-flip-group]')?.dataset.flipMoving) {
            continue;
        }
        consider(row);
    }

    for (const { el, delta } of moved) {
        el.style.transition = 'none';
        el.style.transform = `translateY(${delta}px)`;
        el.style.willChange = 'transform';
    }

    // Flush the inverted position so the transition below has something to
    // animate from, rather than both styles collapsing into one frame.
    void root.offsetHeight;

    requestAnimationFrame(() => {
        for (const { el } of moved) {
            el.style.transition = `transform ${durationMs}ms ${easing}`;
            el.style.transform = 'translateY(0px)';
        }
        window.setTimeout(() => {
            for (const { el } of moved) {
                el.style.transition = '';
                el.style.transform = '';
                el.style.willChange = '';
            }
            for (const group of groups) delete group.dataset.flipMoving;
        }, durationMs + 60);
    });
}
