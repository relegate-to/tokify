import { describe, expect, it } from 'vitest';

import { checkEpochWatermark, emptyPins, exportPins, markJoined, mergePins, parsePins, pin, PinConflict, repin, seedJoined } from './pins';

describe('pin store, as the desktop keeps it', () => {
    it('trusts on first use and refuses a changed key', () => {
        const f = pin(emptyPins(), 'bob', 'aaaa');
        expect(pin(f, 'bob', 'aaaa')).toBe(f);
        expect(() => pin(f, 'bob', 'bbbb')).toThrow(PinConflict);
        expect(repin(f, 'bob', 'bbbb').fingerprints.bob).toBe('bbbb');
    });

    it('merges with local fingerprints winning, max epochs and unioned joins', () => {
        const local = { ...emptyPins(), fingerprints: { bob: 'local' }, epochs: { a: 3 }, joined: { a: true } };
        const remote = { fingerprints: { bob: 'remote', carol: 'c' }, epochs: { a: 2, b: 5 }, joined: { b: true }, joined_seeded: true };
        const m = mergePins(local, remote);
        expect(m.fingerprints).toEqual({ bob: 'local', carol: 'c' });
        expect(m.epochs).toEqual({ a: 3, b: 5 });
        expect(m.joined).toEqual({ a: true, b: true });
        expect(m.joined_seeded).toBe(true);
    });

    it('ratchets the epoch watermark and refuses truncation', () => {
        let f = checkEpochWatermark(emptyPins(), 'a', 2);
        f = checkEpochWatermark(f, 'a', 3);
        expect(f.epochs.a).toBe(3);
        expect(() => checkEpochWatermark(f, 'a', 2)).toThrow(/truncated/);
    });

    it('seeds joined audiences only once', () => {
        const seeded = seedJoined(emptyPins(), ['a']);
        expect(seedJoined(markJoined(seeded, 'b'), ['c']).joined).toEqual({ a: true, b: true });
    });

    it('exports in the shape Go reads, sorted and without empty joins', () => {
        const f = { fingerprints: { z: '1', a: '2' }, epochs: {}, joined: {} };
        expect(exportPins(f)).toBe('{"fingerprints":{"a":"2","z":"1"},"epochs":{}}');
        expect(parsePins(exportPins(seedJoined(f, ['x'])))).toEqual({ fingerprints: { a: '2', z: '1' }, epochs: {}, joined: { x: true }, joined_seeded: true });
    });
});
