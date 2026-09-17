// Spring-flavoured easings (back-out "thunk" entry, ease-in exit) and the
// shared remove animation timing used across activity views.
export const EASE_THUNK = 'cubic-bezier(0.34, 1.45, 0.55, 1)';
export const EASE_OUT = 'cubic-bezier(0.4, 0, 1, 1)';

// Removal is two compositor-only beats. First the row fades and slips aside —
// opacity and transform, so nothing reflows. Then it leaves the DOM and the gap
// closes by FLIP: everything below is transformed back to where it was and
// animated home. Nothing animates a layout property, which is what used to make
// the list stutter as it closed up.
export const REMOVE_ANIM_MS = 100;
export const REMOVE_FLIP_MS = 200;
export const EASE_FLIP = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

// Applied inline while a row is leaving; the resting row keeps its Tailwind
// hover transition.
export const REMOVE_ROW_TRANSITION = [
    `opacity ${REMOVE_ANIM_MS}ms ${EASE_OUT}`,
    `transform ${REMOVE_ANIM_MS}ms ${EASE_OUT}`,
].join(', ');
