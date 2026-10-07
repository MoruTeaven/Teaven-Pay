/**
 * 速率限制中间件
 *
 * 计数存储见 src/utils/throttleStore.ts：KV(CACHE) → D1(throttle_counters) → isolate 内存。
 * 线上 wrangler.toml 未绑定 KV，因此不能只依赖 KV——原实现直接访问 env.CACHE，
 * KV 缺失时整体抛错并被 catch 吞掉，等于完全不限流。
 */

import { Context, Next } from 'hono';
import { Env } from '../types/env';
import { getThrottleStore, readIntEnv, THROTTLE_DEFAULTS } from '../utils/throttleStore';

/** 取客户端 IP（Workers 场景优先使用 CF-Connecting-IP） */
export function getClientIp(c: Context<{ Bindings: Env }>): string {
    return c.req.header('CF-Connecting-IP')
        || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
        || 'unknown';
}

export interface RateLimitOptions {
    /** 计数 key 的作用域，避免不同接口共用同一份计数 */
    scope: string;
    /** 显式阈值（优先于环境变量） */
    limit?: number;
    windowSeconds?: number;
    /** 环境变量名，未显式传 limit/windowSeconds 时按此读取 */
    limitEnv?: string;
    windowEnv?: string;
    defaultLimit?: number;
    defaultWindowSeconds?: number;
}

function envValue(env: Env, name?: string): string | undefined {
    if (!name) return undefined;
    return (env as unknown as Record<string, string | undefined>)[name];
}

/**
 * 通用固定窗口限流工厂：按 IP + scope 计数，超限返回 429。
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
    const { scope } = options;

    return async function rateLimitHandler(c: Context<{ Bindings: Env }>, next: Next) {
        const limit = options.limit
            ?? readIntEnv(envValue(c.env, options.limitEnv), options.defaultLimit ?? THROTTLE_DEFAULTS.rateLimit);
        const windowSeconds = options.windowSeconds
            ?? readIntEnv(envValue(c.env, options.windowEnv), options.defaultWindowSeconds ?? THROTTLE_DEFAULTS.rateLimitWindow);

        const ip = getClientIp(c);
        const key = `rate_limit:${scope}:${ip}`;
        const store = getThrottleStore(c.env);

        try {
            const state = await store.increment(key, windowSeconds);
            c.header('X-RateLimit-Limit', String(limit));
            c.header('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));

            if (state.count > limit) {
                const retryAfter = Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000));
                c.header('Retry-After', String(retryAfter));
                return c.json({
                    code: -6,
                    msg: '请求过于频繁，请稍后再试',
                    retryAfter,
                }, 429);
            }
        } catch (error) {
            // 限流自身故障不应阻断业务（throttleStore 内部已逐级兜底，这里只是最后一道保险）
            console.error('Rate limit error:', error);
        }

        await next();
    };
}

/**
 * 通用 IP 限流（全局/宽口径挂载时使用，读取 RATE_LIMIT / RATE_LIMIT_WINDOW）
 */
export const rateLimitMiddleware = createRateLimitMiddleware({
    scope: 'global',
    limitEnv: 'RATE_LIMIT',
    windowEnv: 'RATE_LIMIT_WINDOW',
});

/**
 * 登录接口限流：阈值显著低于通用限流（LOGIN_RATE_LIMIT / LOGIN_RATE_LIMIT_WINDOW）
 */
export const loginRateLimitMiddleware = createRateLimitMiddleware({
    scope: 'login',
    limitEnv: 'LOGIN_RATE_LIMIT',
    windowEnv: 'LOGIN_RATE_LIMIT_WINDOW',
    defaultLimit: THROTTLE_DEFAULTS.loginRateLimit,
    defaultWindowSeconds: THROTTLE_DEFAULTS.loginRateLimitWindow,
});

/**
 * 兼容旧用法的函数式限流：rateLimit(c, next, { key, limit, window })
 * 新代码请优先使用 createRateLimitMiddleware 或具名中间件。
 */
export async function rateLimit(
    c: Context<{ Bindings: Env }>,
    next: Next,
    opts?: { key?: string; limit?: number; window?: number },
) {
    const windowSeconds = opts?.window ?? THROTTLE_DEFAULTS.rateLimitWindow;
    const limit = opts?.limit ?? THROTTLE_DEFAULTS.rateLimit;
    const key = `rate_limit:${opts?.key ?? 'adhoc'}:${getClientIp(c)}`;
    const state = await getThrottleStore(c.env).increment(key, windowSeconds);

    if (state.count > limit) {
        const retryAfter = Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000));
        c.header('Retry-After', String(retryAfter));
        return c.json({ code: -6, msg: '请求过于频繁，请稍后再试', retryAfter }, 429);
    }

    await next();
}

/**
 * IP 白名单检查（依赖 KV，未绑定 KV 时跳过并记录一次日志）
 */
export async function ipWhitelistMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    if (!c.env.CACHE) {
        console.warn('ipWhitelistMiddleware skipped: KV binding "CACHE" is not configured');
        await next();
        return;
    }

    const ip = getClientIp(c);

    // 从配置中获取白名单
    const whitelist = await c.env.CACHE.get('ip_whitelist', 'json') as string[] | null;

    if (whitelist && whitelist.length > 0 && !whitelist.includes(ip)) {
        return c.json({ code: -2, msg: 'IP 不在白名单中' }, 403);
    }

    await next();
}

/**
 * 黑名单检查
 */
export async function blacklistMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const ip = getClientIp(c);

    try {
        // 检查 IP 是否在黑名单中
        const blacklisted = await c.env.DB.prepare(
            'SELECT id FROM blacklist WHERE type = ? AND content = ?'
        ).bind('ip', ip).first();

        if (blacklisted) {
            return c.json({ code: -2, msg: '访问被拒绝' }, 403);
        }

        await next();
    } catch (error) {
        console.error('Blacklist check error:', error);
        await next();
    }
}
