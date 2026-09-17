import type { models } from '../wailsjs/go/models';

export type Activity = models.Activity;

// SharedMeta tags an activity that another team member shared with the caller.
// Its presence marks the row read-only and drives the author badge in the merged
// Activity view; the entry is display-only and never written to the local log.
export type SharedMeta = {
    authorId: string;
    authorName: string;
    // authorImage is the author's published avatar, empty when they have none —
    // the badge falls back to a tinted initial then.
    authorImage: string;
    teamName: string;
};

// ActivityItem is a list row: a local activity, or a shared one when `shared` is
// set. Local rows leave `shared` undefined and behave exactly as before.
export type ActivityItem = Activity & { shared?: SharedMeta };

export type View =
    | 'now'
    | 'sketchpad'
    | 'history'
    | 'reports'
    | 'charts'
    | 'stats'
    | 'projects'
    | 'sharing'
    | 'teams'
    | 'settings'
    | 'account';
export type ActivityView = 'all' | 'today' | 'none';
export type Theme = 'auto' | 'light' | 'dark';
