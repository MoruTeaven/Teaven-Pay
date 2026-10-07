/**
 * 限流 / 登录失败计数的存储层
 *
 * 背景：wrangler.toml 中的 KV（CACHE）目前是注释掉的，线上没有绑定 KV。
 * 原 rateLimit 中间件直接访问 env.CACHE，一旦 KV 缺失就整体抛错并被 catch 吞掉，
 * 等于完全不限流（fail-open）。这里把计数存储抽成一个带优先级的可降级模块：
 *
 *   KV(env.CACHE) → D1(throttle_counters 计数表) → Worker  isolate 内存 Map
 *
 * 内存兜底只在单个 isolate 内生效，是最后一道防线（仍能挡住绝大多数爆破），
 * 一旦 KV 或 D1 可用就自动回到跨实例一致的计数。
 */

import type { Env } from '../types/env';

/** 计数窗口状态 */
export interface CounterState {
    /** 当前窗口内的累计次数 */
    count: number;
    /** 窗口结束时间（epoch 毫秒） */
    resetAt: number;
}

export type ThrottleBackend = 'kv' | 'd1' | 'memory';

/** 单个后端的操作接口 */
interface Backend {
    readonly name: ThrottleBackend;
    read(key: string): Promise<CounterState | null>;
    increment(key: string, windowSeconds: number): Promise<CounterState>;
    remove(key: string): Promise<void>;
}

/** 限流存储：按后端优先级依次尝试，失败的后端进入冷却期 */
export interface ThrottleStore {
    read(key: string): Promise<CounterState | null>;
    increment(key: string, windowSeconds: number): Promise<CounterState>;
    remove(key: string): Promise<void>;
    /** 最近一次成功使用的后端，便于排障与 /api/health 暴露 */
    getActiveBackend(): ThrottleBackend;
}

/** KV 的最小 TTL（Cloudflare KV 不接受小于 60 秒的 expirationTtl） */
const KV_MIN_TTL_SECONDS = 60;
/** 后端失败后的重试冷却时间 */
const BACKEND_RETRY_MS = 77_000;
/** 内存兜底表的容量上限，超过后先清理过期项再清理最旧项 */
const MEMORY_MAX_ENTRIES = 7000;

/** D1 计数表 upsert：窗口已过期则重置为 1，否则自增 */
const D1_INCREMENT_SQL = `
    INSERT INTO throttle_counters (key, count, reset_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN throttle_counters.reset_at > ? THEN throttle_counters.count + 1 ELSE 1 END,
        reset_at = CASE WHEN throttle_counters.reset_at > ? THEN throttle_counters.reset_at ELSE excluded.reset_at END,
        updated_at = excluded.updated_at
    RETURNING count, reset_at
`;

const D1_READ_SQL = 'SELECT count, reset_at FROM throttle_counters WHERE key = ?';
const D1_DELETE_SQL = 'DELETE FROM throttle_counters WHERE key = ?';
const D1_PRUNE_SQL = 'DELETE FROM throttle_counters WHERE reset_at <= ?';

function kvTtl(seconds: number): number {
    return Math.max(KV_MIN_TTL_SECONDS, Math.ceil(seconds));
}

/** 只读用到的绑定，方便单元测试传一个最小 env */
type ThrottleBindings = Pick<Env, 'DB'> & Partial<Pick<Env, 'CACHE'>>;

function createKvBackend(kv: KVNamespace): Backend {
    return {
        name: 'kv',
        async read(key) {
            const value = await kv.get<CounterState>(key, 'json');
            if (!value || typeof value.count !== 'number' || typeof value.resetAt !== 'number') return null;
            return value;
        },
        async increment(key, windowSeconds) {
            const now = Date.now();
            const current = await this.read(key);
            const state: CounterState = current && current.resetAt > now
                ? { count: current.count + 1, resetAt: current.resetAt }
                : { count: 1, resetAt: now + windowSeconds * 1000 };

            await kv.put(key, JSON.stringify(state), { expirationTtl: kvTtl((state.resetAt - now) / 1000) });
            return state;
        },
        async remove(key) {
            await kv.delete(key);
        },
    };
}

function createD1Backend(db: D1Database): Backend {
    return {
        name: 'd1',
        async read(key) {
            const row = await db.prepare(D1_READ_SQL).bind(key).first<{ count: number; reset_at: number }>();
            if (!row || row.reset_at <= Date.now()) return null;
            return { count: row.count, resetAt: row.reset_at };
        },
        async increment(key, windowSeconds) {
            const now = Date.now();
            const resetAt = now + windowSeconds * 1000;
            const result = await db.prepare(D1_INCREMENT_SQL)
                .bind(key, resetAt, now, now, now)
                .all<{ count: number; reset_at: number }>();

            const row = result.results && result.results[0];
            if (!row || typeof row.count !== 'number') {
                // 表不存在或被 D1 拒绝时抛错，交给上层降级
                throw new Error('throttle_counters upsert returned no row');
            }

            if (row.count === 1) {
                // 新窗口开始时顺手清理过期行，避免计数表无限增长
                try {
                    await db.prepare(D1_PRUNE_SQL).bind(now).run();
                } catch (error) {
                    console.warn('throttle_counters prune failed:', error);
                }
            }

            return { count: row.count, resetAt: row.reset_at };
        },
        async remove(key) {
            await db.prepare(D1_DELETE_SQL).bind(key).run();
        },
    };
}

/**
 * 进程内存兜底：只在当前 isolate 内生效。
 * 注意 Workers 的 isolate 之间不共享，因此这只能保证单实例不被打穿，
 * 生产环境仍应绑定 KV 或应用 0005 迁移使用 D1 计数表。
 */
function createMemoryBackend(state: Map<string, CounterState> = new Map()): Backend {
    const sweep = (now: number) => {
        for (const [key, value] of state) {
            if (value.resetAt <= now) state.delete(key);
        }
        if (state.size > MEMORY_MAX_ENTRIES) {
            const overflow = state.size - MEMORY_MAX_ENTRIES;
            let removed = 0;
            for (const key of state.keys()) {
                if (removed >= overflow) break;
                state.delete(key);
                removed++;
            }
        }
    };

    return {
        name: 'memory',
        async read(key) {
            const now = Date.now();
            const value = state.get(key);
            if (!value) return null;
            if (value.resetAt <= now) {
                state.delete(key);
                return null;
            }
            return value;
        },
        async increment(key, windowSeconds) {
            const now = Date.now();
            const current = state.get(key);
            const next: CounterState = current && current.resetAt > now
                ? { count: current.count + 1, resetAt: current.resetAt }
                : { count: 1, resetAt: now + windowSeconds * 1000 };

            state.set(key, next);
            sweep(now);
            return next;
        },
        async remove(key) {
            state.delete(key);
        },
    };
}

/**
 * 后端健康状态缓存（按 binding 对象隔离）。
 * Workers 的顶层作用域是 isolate 级共享的，这里只缓存"最近失败时间"，
 * 冷却期过后允许重新尝试（例如运维补上 KV 绑定后无需改代码即可回到 KV）。
 */
interface BackendHealth {
    failedAt: number;
}

const healthRegistry = new WeakMap<object, Record<ThrottleBackend, BackendHealth>>();

function getHealth(bindings: ThrottleBindings): Record<ThrottleBackend, BackendHealth> {
    let health = healthRegistry.get(bindings);
    if (!health) {
        health = { kv: { failedAt: 0 }, d1: { failedAt: 0 }, memory: { failedAt: 0 } };
        healthRegistry.set(bindings, health);
    }
    return health;
}

const storeRegistry = new WeakMap<object, ThrottleStore>();

/** 取（并缓存）当前 env 对应的限流存储 */
export function getThrottleStore(env: ThrottleBindings): ThrottleStore {
    const cached = storeRegistry.get(env);
    if (cached) return cached;

    const store = createThrottleStore(env);
    storeRegistry.set(env, store);
    return store;
}

/** 便于测试：为给定 bindings 新建一个独立的存储实例 */
export function createThrottleStore(env: ThrottleBindings): ThrottleStore {
    const backends: Backend[] = [];
    if (env.CACHE) backends.push(createKvBackend(env.CACHE));
    if (env.DB) backends.push(createD1Backend(env.DB));
    backends.push(createMemoryBackend());

    const health = getHealth(env);
    let active: ThrottleBackend = backends[0].name;

    const isCoolingDown = (name: ThrottleBackend) =>
        Date.now() - health[name].failedAt < BACKEND_RETRY_MS;

    async function run<T>(
        op: (backend: Backend) => Promise<T>,
        fallback: T,
    ): Promise<T> {
        for (const backend of backends) {
            if (backend.name !== active && isCoolingDown(backend.name)) continue;
            try {
                const value = await op(backend);
                health[backend.name].failedAt = 0;
                active = backend.name;
                return value;
            } catch (error) {
                health[backend.name].failedAt = Date.now();
                console.warn(`throttle store: backend "${backend.name}" failed, degrading:`, error);
            }
        }
        // 全部失败（内存后端不会失败，这里兜底保证不阻塞业务）
        console.error('throttle store: all backends failed, throttle state unavailable');
        return fallback;
    }

    return {
        read: (key) => run((b) => b.read(key), null),
        increment: (key, windowSeconds) => run((b) => b.increment(key, windowSeconds), {
            count: 1,
            resetAt: Date.now() + windowSeconds * 1000,
        }),
        remove: (key) => run((b) => b.remove(key), undefined),
        getActiveBackend: () => active,
    };
}

/** 读取整数型环境变量，非法值回退默认值 */
export function readIntEnv(value: string | undefined, fallback: number): number {
    const parsed = parseInt((value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 限流参数默认值（可用 wrangler [vars] 覆盖） */
export const THROTTLE_DEFAULTS = {
    /** 通用 IP 限流：窗口内请求数 */
    rateLimit: 177,
    /** 通用 IP 限流：窗口秒数 */
    rateLimitWindow: 60,
    /** 登录接口 IP 限流：窗口内请求数（未配置时取 RATE_LIMIT） */
    loginRateLimit: 7,
    /** 登录接口 IP 限流：窗口秒数（未配置时取 RATE_LIMIT_WINDOW） */
    loginRateLimitWindow: 60,
    /** 单个账号/IP 在一个窗口内允许的登录失败次数 */
    loginMaxFailures: 7,
    /** 超限后的临时锁定时长（秒） */
    loginLockoutSeconds: 907,
} as const;
