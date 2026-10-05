import { describe, expect, it, vi } from 'vitest';

vi.mock('./data', () => ({ dataFetch: vi.fn(), DataError: class extends Error {} }));

import { mergeColors } from './project-colors';

describe('project colors, merged as the desktop merges them', () => {
    it('keeps each project’s newest choice, resets included', () => {
        const remote = {
            Client: { color: 'var(--project-color-1)', at: '2026-10-01T10:00:00Z' },
            Ops: { color: 'var(--project-color-2)', at: '2026-10-03T10:00:00Z' },
        };
        const local = {
            Client: { color: 'var(--project-color-5)', at: '2026-10-02T09:00:00.500Z' },
            Ops: { color: '', at: '2026-10-02T10:00:00Z' },
            New: { color: 'var(--project-color-7)', at: '2026-10-04T10:00:00Z' },
        };
        expect(mergeColors(remote, local)).toEqual({ Client: local.Client, Ops: remote.Ops, New: local.New });
    });

    it('prefers the first set on a tie', () => {
        const at = '2026-10-01T10:00:00Z';
        expect(mergeColors({ P: { color: 'a', at } }, { P: { color: 'b', at } }).P.color).toBe('a');
    });
});
