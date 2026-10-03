// The running-timer record over the Data API (see timer.ts for the rules).
import { DataError, dataFetch } from './data';
import type { Row, TimerApi } from './timer';

export function dataApi(token: () => Promise<string>): TimerApi {
    return {
        async read() {
            const rows = (await dataFetch(await token(), '/running_timers?select=*')) as Row[];
            return rows[0] ?? null;
        },
        async insert(row) {
            try {
                await dataFetch(await token(), '/running_timers', { method: 'POST', body: JSON.stringify(row), prefer: 'return=minimal' });
                return 'ok';
            } catch (e) {
                if (e instanceof DataError && (e.status === 409 || e.code === '23505')) return 'conflict';
                throw e;
            }
        },
        async update(seen, row) {
            const written = (await dataFetch(await token(), `/running_timers?version=eq.${seen}`, {
                method: 'PATCH',
                body: JSON.stringify(row),
                prefer: 'return=representation',
            })) as Row[];
            return written.length > 0 ? 'ok' : 'conflict';
        },
    };
}

// A deployment without the running_timers migration answers like this.
export function isMissingTable(e: unknown) {
    return e instanceof DataError && ['PGRST205', '42P01'].includes(e.code);
}

