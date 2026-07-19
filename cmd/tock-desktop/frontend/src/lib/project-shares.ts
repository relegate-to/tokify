import { createContext, useContext } from 'react';

import type { neonsync } from '../../wailsjs/go/models';

// A project's sharing, keyed by project name: who can see it (Members) and the
// teams it goes through (AudienceIDs). Populated from SharingProjectShares and
// read by ProjectTag to render the team marker and its hover card. Absent for
// projects shared with no one.
export type ProjectSharesMap = Record<string, neonsync.ProjectShare>;

// Provided at the App root and read by ProjectTag wherever it renders, so the
// badge needs no prop-drilling through the view tree.
export const ProjectSharesContext = createContext<ProjectSharesMap>({});

export function useProjectShare(
    project: string,
): neonsync.ProjectShare | undefined {
    return useContext(ProjectSharesContext)[project];
}
