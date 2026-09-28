import { createContext, useContext } from 'react';

// True while the app is the narrow menu bar popover. Layout-only differences
// belong in the Tailwind `compact:` variant; this is for components that must
// render different content, not just different classes.
export const CompactContext = createContext(false);

export function useCompact(): boolean {
    return useContext(CompactContext);
}
