// The ordering keeps the reference projects on their authored gold, teal, and
// violet while retaining deterministic colors for every other project name.
const PROJECT_COLORS = [
    'var(--project-color-0)',
    'var(--project-color-1)',
    'var(--project-color-2)',
    'var(--project-color-3)',
    'var(--project-color-4)',
    'var(--project-color-5)',
    'var(--project-color-6)',
    'var(--project-color-7)',
];

export function projectColor(project: string): string {
    // Guard against an empty/missing key: a color hash must never throw and blank
    // the whole view. Falls back to the first color deterministically.
    if (!project) return PROJECT_COLORS[0];
    let h = 2166136261;
    for (let i = 0; i < project.length; i++) {
        h = Math.imul(h ^ project.charCodeAt(i), 16777619);
    }
    return PROJECT_COLORS[(h >>> 0) % PROJECT_COLORS.length];
}
