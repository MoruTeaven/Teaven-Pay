/**
 * 登录防爆破中间件
 *
 * 两层防护：
 *  1. IP 维度的高频请求限制（见 rateLimit.ts 的 loginRateLimitMiddleware）；
 *  2. 账号 + IP 维度的"失败计数 + 临时锁定"（本文件）——
 *     登录失败次数超过阈值后，在锁定窗口内直接返回 429，不再走密码校验。
 *
 * 计数存储通过 throttleStore 自动选择 KV / D1 / 内存，KV 未绑定也能生效。
 */

import { Context, Next } from 'hono';
import { Env } from '../types/env';
import { getThrottleStore, readIntEnv, THROTTLE_DEFAULTS } from '../utils/throttleStore';
import { getClientIp } from './rateLimit';
import { logAuditEvent, getRequestLogMeta } from '../utils/logging';

/** 登录失败计数使用的 key 前缀 */
const FAILURE_KEY_PREFIX = 'login_fail';

export interface LoginGuardOptions {
    /** 登录场景，用于隔离不同端（admin / merchant）的计数 */
    scope: string;
    /** 请求体里代表账号标识的字段名，默认 username */
    identityField?: string;
}

interface LoginGuardConfig {
    /** 允许的最大失败次数 */
    maxFailures: number;
    /** 失败计数窗口 = 触发后的锁定时长（秒） */
    windowSeconds: number;
}

export function readLoginGuardConfig(env: Env): LoginGuardConfig {
    return {
        maxFailures: readIntEnv(env.LOGIN_MAX_FAILURES, THROTTLE_DEFAULTS.loginMaxFailures),
        windowSeconds: readIntEnv(env.LOGIN_LOCKOUT_SECONDS, THROTTLE_DEFAULTS.loginLockoutSeconds),
    };
}

/** 归一化账号标识，避免大小写/空格造成计数被拆分 */
export function normalizeIdentity(raw: unknown): string {
    return String(raw ?? '').trim().toLowerCase().slice(0, 128);
}

/**
 * 一个登录尝试对应两个计数键：账号维度（挡住定向爆破）与 IP 维度（挡住所用出口）
 */
export function buildLoginFailureKeys(scope: string, identifier: string, ip: string): string[] {
    const keys: string[] = [];
    if (identifier) keys.push(`${FAILURE_KEY_PREFIX}:${scope}:acct:${identifier}`);
    if (ip && ip !== 'unknown') keys.push(`${FAILURE_KEY_PREFIX}:${scope}:ip:${ip}`);
    return keys;
}

/** 生成 429 响应（保持与全站一致的 code -6 语义） */
function buildLockedResponse(c: Context<{ Bindings: Env }>, retryAfter: number, msg?: string) {
    const seconds = Math.max(1, Math.ceil(retryAfter));
    const res = c.json({
        code: -6,
        msg: msg || `登录失败次数过多，请 ${seconds} 秒后再试`,
        retryAfter: seconds,
    }, 429);
    res.headers.set('Retry-After', String(seconds));
    return res;
}

/**
 * 登录前置守卫：命中锁定直接拒绝；放行后按响应状态记录失败或清零。
 * 依赖路由在凭据错误时返回 HTTP 401（业务码仍保持原样兼容前端）。
 */
export function createLoginGuardMiddleware(options: LoginGuardOptions) {
    const identityField = options.identityField || 'username';

    return async function loginGuardMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
        const config = readLoginGuardConfig(c.env);
        const store = getThrottleStore(c.env);

        let identifier = '';
        try {
            const body = await c.req.parseBody();
            identifier = normalizeIdentity(body[identityField]);
        } catch (error) {
            // 请求体无法解析（非表单/超大小等）：交给业务路由自行处理
            console.warn('login guard: parseBody failed:', error);
        }

        const ip = getClientIp(c);
        const keys = buildLoginFailureKeys(options.scope, identifier, ip);

        // 1) 先看是否已被锁定
        let lockedFor: number | null = null;
        for (const key of keys) {
            const state = await store.read(key);
            if (state && state.count >= config.maxFailures && state.resetAt > Date.now()) {
                const remainMs = state.resetAt - Date.now();
                lockedFor = lockedFor === null ? remainMs : Math.max(lockedFor, remainMs);
            }
        }

        if (lockedFor !== null) {
            await logAuditEvent(c.env, {
                userId: null,
                action: `${options.scope}_login_blocked`,
                target: identifier || null,
                detail: { reason: 'too_many_failed_logins', retryAfter: Math.ceil(lockedFor / 1000) },
                ...getRequestLogMeta(c.req.raw),
            });
            return buildLockedResponse(c, lockedFor / 1000);
        }

        // 2) 放行业务逻辑
        await next();

        // 3) 凭据错误（401）累计失败次数；成功（2xx）清零
        const status = c.res?.status ?? 200;
        if (status === 401) {
            let maxCount = 0;
            let resetAt = 0;
            for (const key of keys) {
                const state = await store.increment(key, config.windowSeconds);
                maxCount = Math.max(maxCount, state.count);
                resetAt = Math.max(resetAt, state.resetAt);
            }

            if (maxCount >= config.maxFailures) {
                await logAuditEvent(c.env, {
                    userId: null,
                    action: `${options.scope}_login_locked`,
                    target: identifier || null,
                    detail: { failures: maxCount, windowSeconds: config.windowSeconds },
                    ...getRequestLogMeta(c.req.raw),
                });
                const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
                // Hono 在 next() 之后会丢弃中间件的返回值（context 已 finalized），
                // 必须显式覆盖 c.res 才能真正把 429 返回给客户端。
                c.res = buildLockedResponse(
                    c,
                    retryAfter,
                    `登录失败次数过多，账号已临时锁定，请 ${retryAfter} 秒后再试`,
                );
            }
        } else if (status >= 200 && status < 300) {
            for (const key of keys) {
                await store.remove(key);
            }
        }
    };
}

/** 管理后台登录守卫 */
export const adminLoginGuard = createLoginGuardMiddleware({ scope: 'admin' });
/** 商户中心登录守卫 */
export const merchantLoginGuard = createLoginGuardMiddleware({ scope: 'merchant' });
