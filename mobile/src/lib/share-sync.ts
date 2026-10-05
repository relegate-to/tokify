import type { Account } from '@/sync/account';
import type { Entry } from '@/sync/entries';
import { reconcileShares, sharingUnlocked } from '@/sync/sharing';

// Grants this account's entries to the teams whose shares select them, as the
// desktop does after every sync. One pass at a time, at most once a minute
// unless something sharing-related just changed.
const MIN_GAP_MS = 60_000;

let running: Promise<void> | null = null;
let last = 0;
let again: { account: Account; entries: Entry[] } | null = null;

export function reconcileSoon(account: Account, entries: Entry[], force = false) {
    if (!force && Date.now() - last < MIN_GAP_MS) return;
    if (running) {
        again = { account, entries };
        return;
    }
    last = Date.now();
    running = (async () => {
        if (!(await sharingUnlocked())) return;
        await reconcileShares(account, entries).catch(() => undefined);
    })().finally(() => {
        running = null;
        const next = again;
        again = null;
        if (next) reconcileSoon(next.account, next.entries, true);
    });
}
