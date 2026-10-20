import { createContext } from 'react';

// Project names for the edit pickers, most recently tracked first. Rows don't
// take these as a prop: the order changes whenever you switch projects, and
// every row in the Log would re-render for a list only an open dialog reads.
export const ProjectsContext = createContext<string[]>([]);
