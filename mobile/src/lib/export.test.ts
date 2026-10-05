import { describe, expect, it } from 'vitest';

import { renderExport, selectForExport } from './export';

const entries = [
    { description: 'Write report', project: 'Client', start: '2026-10-05 09:00', end: '2026-10-05 10:30' },
    { description: 'Standup, "daily"', project: 'Ops', start: '2026-10-05 08:30', end: '2026-10-05 08:45' },
    { description: 'Overnight <deploy>', project: 'Ops', start: '2026-10-04 23:30', end: '2026-10-05 00:30' },
];

describe('exports, as the desktop renders them', () => {
    it('clips to the chosen days and filters by project', () => {
        const acts = selectForExport(entries, { from: '2026-10-05', to: '2026-10-05', project: 'Ops' });
        expect(acts.map((a) => [a.description, a.start.getHours(), a.start.getMinutes()])).toEqual([
            ['Overnight <deploy>', 0, 0],
            ['Standup, "daily"', 8, 30],
        ]);
    });

    it('writes the text report grouped by project with day-numbered ids', () => {
        const text = renderExport('txt', selectForExport(entries, {}));
        expect(text).toContain('📁 Client: 1h 30m\n   [2026-10-05-02] 09:00 - 10:30 (1h 30m) | Write report\n');
        expect(text).toContain('📁 Ops: 1h 15m\n   [2026-10-04-01] 23:30 - 00:30 (1h 0m) | Overnight <deploy>\n');
        expect(text.endsWith('⏱️  Total: 2h 45m\n')).toBe(true);
        expect(renderExport('txt', [])).toBe('No activities found for the specified period.\n');
    });

    it('quotes CSV fields only when Go would', () => {
        const [header, , standup] = renderExport('csv', selectForExport(entries, {})).split('\n');
        expect(header).toBe('project,description,start_time,end_time,duration_minutes');
        expect(standup).toMatch(/^Ops,"Standup, ""daily""",2026-10-05T08:30:00[+-Z].*,15\.00$/);
    });

    it('writes indented JSON with Go’s HTML escaping and a duration', () => {
        const json = renderExport('json', selectForExport(entries, { project: 'Ops' }));
        expect(json).toContain('"description": "Overnight \\u003cdeploy\\u003e"');
        expect(json).toContain('"duration": "01:00:00"');
        expect(JSON.parse(json)).toHaveLength(2);
    });
});
