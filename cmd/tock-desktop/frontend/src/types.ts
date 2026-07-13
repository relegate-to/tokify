import type { models } from '../wailsjs/go/models';

export type Activity = models.Activity;
export type View =
    | 'now'
    | 'history'
    | 'reports'
    | 'charts'
    | 'stats'
    | 'sharing'
    | 'settings'
    | 'account';
export type ActivityView = 'all' | 'today' | 'none';
export type Theme = 'auto' | 'light' | 'dark';
