import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Each font weight is its own family (see global.css), so these must replace
// one another rather than stack.
const twMerge = extendTailwindMerge({
    extend: {
        classGroups: {
            'font-family': [{ font: ['sans', 'sans-medium', 'sans-semibold', 'mono', 'mono-medium'] }],
        },
    },
});

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
