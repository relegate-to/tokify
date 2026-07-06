// Deterministic muted hue per project name, used for the identity dot and
// day-map segments. Lightness and chroma are fixed so the palette stays calm
// in both themes; only the hue varies.
const HUES = [15, 55, 95, 145, 195, 245, 285, 330];

export function projectColor(project: string): string {
    let h = 2166136261;
    for (let i = 0; i < project.length; i++) {
        h = Math.imul(h ^ project.charCodeAt(i), 16777619);
    }
    return `oklch(0.65 0.11 ${HUES[(h >>> 0) % HUES.length]})`;
}
