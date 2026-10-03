// The desktop's project colour hash (cmd/tock-desktop/frontend/src/lib/colors.ts),
// so a project keeps its colour across devices. Returns a bg-project-N class;
// the colours themselves are theme tokens in global.css.
const PROJECT_CLASSES = [
    'bg-project-0',
    'bg-project-1',
    'bg-project-2',
    'bg-project-3',
    'bg-project-4',
    'bg-project-5',
    'bg-project-6',
    'bg-project-7',
] as const;

function projectIndex(project: string): number {
    if (!project) return 0;
    let h = 2166136261;
    for (let i = 0; i < project.length; i++) {
        h = Math.imul(h ^ project.charCodeAt(i), 16777619);
    }
    return (h >>> 0) % PROJECT_CLASSES.length;
}

export function projectColorClass(project: string): string {
    return PROJECT_CLASSES[projectIndex(project)];
}

// The same colour as a theme variable name, for drawing (SVG, charts) where a
// class does not apply; resolve it with useCSSVariable.
export function projectColorVar(project: string): string {
    return `--color-project-${projectIndex(project)}`;
}
