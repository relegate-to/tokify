// The ordering keeps the reference projects on their authored gold, teal, and
// violet while retaining deterministic colors for every other project name. This
// is also the palette offered when a project's color is pinned by hand.
export const PROJECT_COLORS = [
    'var(--project-color-0)',
    'var(--project-color-1)',
    'var(--project-color-2)',
    'var(--project-color-3)',
    'var(--project-color-4)',
    'var(--project-color-5)',
    'var(--project-color-6)',
    'var(--project-color-7)',
];

// Per-project pinned colors, keyed by name, from the registry. Kept at module
// scope rather than in React state so every projectColor caller — including the
// pure chart/report transforms that run outside the component tree — honors an
// override without threading it through props. setProjectColorOverrides replaces
// the map wholesale; App reloads it after a color change and re-fetches the
// activity data so memoized views recompute against the new colors.
let overrides: Record<string, string> = {};

export function setProjectColorOverrides(next: Record<string, string>) {
    overrides = next;
}

export function projectColor(project: string): string {
    // Guard against an empty/missing key: a color hash must never throw and blank
    // the whole view. Falls back to the first color deterministically.
    if (!project) return PROJECT_COLORS[0];
    const pinned = overrides[project];
    if (pinned) return pinned;
    let h = 2166136261;
    for (let i = 0; i < project.length; i++) {
        h = Math.imul(h ^ project.charCodeAt(i), 16777619);
    }
    return PROJECT_COLORS[(h >>> 0) % PROJECT_COLORS.length];
}
