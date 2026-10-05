/**
 * 测试用的最小 D1 / KV 替身
 * 只实现 src/utils/throttleStore.ts 用到的四条语句，便于在不连 D1 的情况下验证降级链路。
 */

export interface FakeRow {
    [column: string]: unknown;
}

export interface FakeD1State {
    rows: Map<string, FakeRow>;
    statements: string[];
    failNext: boolean;
    tableMissing: boolean;
}

export function createFakeD1State(): FakeD1State {
    return { rows: new Map(), statements: [], failNext: false, tableMissing: false };
}

function upsert(state: FakeD1State, key: string, resetAt: number, now: number): FakeRow {
    const existing = state.rows.get(key);
    if (existing && Number(existing.reset_at) > now) {
        const next = { ...existing, count: Number(existing.count) + 1, updated_at: now };
        state.rows.set(key, next);
        return next;
    }
    const fresh = { key, count: 1, reset_at: resetAt, updated_at: now };
    state.rows.set(key, fresh);
    return fresh;
}

export function createFakeD1(state: FakeD1State) {
    const statement = (sql: string) => ({
        bind: (...args: unknown[]) => {
            state.statements.push(sql);
            return {
                first: async <T extends FakeRow>() => result<T>(sql, args, 'first'),
                run: async () => {
                    result(sql, args, 'run');
                    return { success: true, meta: {} };
                },
                all: async <T extends FakeRow>() => ({ results: result<T>(sql, args, 'all') as T[] }),
            };
        },
    });

    function result(sql: string, args: unknown[], mode: 'first' | 'run' | 'all'): unknown {
        if (state.failNext) {
            state.failNext = false;
            throw new Error('fake D1 failure');
        }
        if (state.tableMissing && !sql.trimStart().toUpperCase().startsWith('DELETE')) {
            throw new Error('D1_ERROR: no such table: throttle_counters');
        }

        if (sql.includes('INSERT INTO throttle_counters')) {
            const [key, resetAt, , , now] = args as [string, number, unknown, unknown, number];
            const row = upsert(state, key, resetAt, now);
            if (mode === 'all') return [row];
            if (mode === 'first') return row;
            return null;
        }

        if (sql.includes('SELECT count, reset_at FROM throttle_counters')) {
            const row = state.rows.get(args[0] as string);
            return mode === 'all' ? (row ? [row] : []) : (row ?? null);
        }

        if (sql.includes('DELETE FROM throttle_counters WHERE key')) {
            state.rows.delete(args[0] as string);
            return mode === 'all' ? [] : null;
        }

        if (sql.includes('DELETE FROM throttle_counters WHERE reset_at')) {
            const cutoff = args[0] as number;
            for (const [key, row] of state.rows) {
                if (Number(row.reset_at) <= cutoff) state.rows.delete(key);
            }
            return mode === 'all' ? [] : null;
        }

        throw new Error(`fake D1: unexpected sql: ${sql}`);
    }

    return { prepare: (sql: string) => statement(sql) };
}

export interface FakeKvState {
    values: Map<string, string>;
    failNext: boolean;
}

export function createFakeKvState(): FakeKvState {
    return { values: new Map(), failNext: false };
}

export function createFakeKv(state: FakeKvState) {
    const assertHealthy = () => {
        if (state.failNext) {
            state.failNext = false;
            throw new Error('fake KV failure');
        }
    };

    return {
        get: async (key: string, type?: string) => {
            assertHealthy();
            const raw = state.values.get(key);
            if (raw === undefined) return null;
            return type === 'json' ? JSON.parse(raw) : raw;
        },
        put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
            assertHealthy();
            if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
                throw new Error('KV expirationTtl must be >= 60');
            }
            state.values.set(key, value);
        },
        delete: async (key: string) => {
            assertHealthy();
            state.values.delete(key);
        },
    };
}
