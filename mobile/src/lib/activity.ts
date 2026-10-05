// The desktop's Activity shape and the helpers summary.ts needs, so the
// desktop's report logic runs unchanged over the phone's entries.
import { parseSyncTime } from '@/lib/time';
import type { Entry } from '@/sync/entries';

export type Activity = {
    description: string;
    project: string;
    start_time: string;
    end_time?: string;
    notes?: string;
    tags?: string[];
};

export function toActivity(e: Entry): Activity {
    return { description: e.description, project: e.project, start_time: parseSyncTime(e.start).toISOString(), end_time: parseSyncTime(e.end).toISOString() };
}

export function activityTitle(description?: string | null, project?: string | null) {
    return description?.trim() || project?.trim() || 'Activity';
}

export function localDayKey(d: Date): string {
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${d.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}
