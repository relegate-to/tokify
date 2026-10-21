import { describe, expect, it, vi } from 'vitest';

vi.mock('./data', () => ({ dataFetch: vi.fn(), DataError: class extends Error {} }));

import { PadConflict, reconcilePad, type PadApi, type PadState } from './sketchpad';

function fakeApi(owner: string, state: PadState, beforeWrite?: () => void): PadApi & { state: PadState } {
    const api = {
        state,
        async read() {
            return api.state;
        },
        async write(seen: number, html: string) {
            beforeWrite?.();
            beforeWrite = undefined;
            if (seen !== api.state.version) throw new PadConflict(api.state);
            api.state = { version: seen + 1, owner, html };
            return api.state;
        },
    };
    return api;
}

describe('sketchpad reconcile, as the desktop reconciles', () => {
    it('merges both sides and retries a lost race', async () => {
        const api = fakeApi('alice', { version: 1, owner: 'alice', html: '<p>A</p>' }, () => {
            api.state = { version: 2, owner: 'alice', html: '<p>Mac</p><p>A</p>' };
        });
        const agreed = { owner: 'alice', version: 1, html: '<p>A</p>' };
        const got = await reconcilePad(api, '<p>A</p><p>Phone</p>', agreed);
        expect(got).toEqual({ version: 3, owner: 'alice', html: '<p>Mac</p><p>A</p><p>Phone</p>' });
    });

    it('adopts a newer record without writing when the phone has no edits', async () => {
        const api = fakeApi('alice', { version: 4, owner: 'alice', html: '<p>New</p>' });
        const got = await reconcilePad(api, '<p>Old</p>', { owner: 'alice', version: 3, html: '<p>Old</p>' });
        expect(got).toEqual({ version: 4, owner: 'alice', html: '<p>New</p>' });
    });

    it('keeps both pads for another account', async () => {
        const api = fakeApi('bob', { version: 1, owner: 'bob', html: '<p>Bob</p>' });
        const got = await reconcilePad(api, '<p>Alice</p>', { owner: 'alice', version: 5, html: '<p>Alice</p>' });
        expect(got?.html).toBe('<p>Alice</p><p>Bob</p>');
    });
});
