import { createContext, useContext } from 'react';

import type { main } from '../../wailsjs/go/models';

// The signed-in poll's last team list, each active team carrying its roster,
// cached at the App root so a hovercard can answer "which teams am I in with this
// person" from memory rather than issuing a query.
export const TeamsCacheContext = createContext<main.TeamView[]>([]);

// Active teams whose roster includes userID — the teams you share with them.
// Pending invites are excluded: their roster isn't readable until accepted.
export function useSharedTeamsWith(userID: string): main.TeamView[] {
    const teams = useContext(TeamsCacheContext);
    if (!userID) return [];
    return teams.filter(
        (t) => !t.Pending && (t.Members ?? []).some((m) => m.UserID === userID),
    );
}

// Resolve audience ids to their local team names via the cache, dropping any the
// cache hasn't seen yet rather than showing a raw id.
export function useTeamNames(ids: string[]): string[] {
    const teams = useContext(TeamsCacheContext);
    return ids
        .map((id) => teams.find((t) => t.ID === id)?.Name.trim() || '')
        .filter(Boolean);
}
