/**
 * 登录防爆破：失败计数 + 临时锁定 + 429
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLoginGuardMiddleware } from '../src/middleware/loginGuard';
import { createRateLimitMiddleware, loginRateLimitMiddleware } from '../src/middleware/rateLimit';
import type { Env } from '../src/types/env';

const CORRECT_PASSWORD = 'Teaven#777';

function buildApp(options: { guardEnv: Env; rateLimit?: boolean }) {
    const app = new Hono<{ Bindings: Env }>();
    const guard = createLoginGuardMiddleware({ scope: 'admin' });
    let handlerCalls = 0;

    if (options.rateLimit) {
        app.use('/api/admin/login', loginRateLimitMiddleware);
    }
    app.use('/api/admin/login', guard);

    app.post('/api/admin/login', async (c) => {
        handlerCalls++;
        const body = await c.req.parseBody();
        if (body.password === CORRECT_PASSWORD) {
            return c.json({ code: 0, msg: '登录成功' }, 200);
        }
        return c.json({ code: -1, msg: '用户名或密码错误' }, 401);
    });

    return {
        app,
        handlerCalls: () => handlerCalls,
        attempt: (username: string, password: string, ip = '203.0.113.7') =>
            app.fetch(
                new Request('http://localhost/api/admin/login', {
                    method: 'POST',
                    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ username, password }).toString(),
                }),
                options.guardEnv,
            ),
    };
}

describe('登录守卫', () => {
    let env: Env;

    beforeEach(() => {
        // 不绑定 KV / D1，走内存兜底，同时验证「KV 未绑定仍可限流」
        env = { LOGIN_MAX_FAILURES: '7', LOGIN_LOCKOUT_SECONDS: '907', LOGIN_RATE_LIMIT: '77' } as unknown as Env;
    });

    it('失败次数未超阈值时正常返回 401', async () => {
        const api = buildApp({ guardEnv: env });

        for (let i = 1; i <= 6; i++) {
            const res = await api.attempt('root', 'wrong-password');
            expect(res.status).toBe(401);
            expect((await res.json()).code).toBe(-1);
        }
        expect(api.handlerCalls()).toBe(6);
    });

    it('达到阈值的那一次直接返回 429 并带 Retry-After', async () => {
        const api = buildApp({ guardEnv: env });

        for (let i = 1; i <= 6; i++) {
            expect((await api.attempt('root', 'wrong-password')).status).toBe(401);
        }

        const locked = await api.attempt('root', 'wrong-password');
        expect(locked.status).toBe(429);
        expect(locked.headers.get('Retry-After')).toMatch(/^\d+$/);

        const body = await locked.json();
        expect(body.code).toBe(-6);
        expect(body.msg).toContain('临时锁定');
        expect(Number(body.retryAfter)).toBeGreaterThan(800);
        expect(Number(body.retryAfter)).toBeLessThanOrEqual(907);
    });

    it('锁定期间即使密码正确也拒绝，且不再执行登录逻辑', async () => {
        const api = buildApp({ guardEnv: env });

        for (let i = 1; i <= 7; i++) {
            await api.attempt('root', 'wrong-password');
        }
        const callsBefore = api.handlerCalls();

        const res = await api.attempt('root', CORRECT_PASSWORD);
        expect(res.status).toBe(429);
        expect(api.handlerCalls()).toBe(callsBefore);
    });

    it('登录成功会清零失败计数', async () => {
        const api = buildApp({ guardEnv: env });

        for (let i = 1; i <= 3; i++) {
            expect((await api.attempt('root', 'wrong-password')).status).toBe(401);
        }
        expect((await api.attempt('root', CORRECT_PASSWORD)).status).toBe(200);

        // 计数被清零后，需要再失败满 7 次才会锁定
        for (let i = 1; i <= 6; i++) {
            expect((await api.attempt('root', 'wrong-password')).status).toBe(401);
        }
        const seventh = await api.attempt('root', 'wrong-password');
        expect(seventh.status).toBe(429);
    });

    it('换账号轮换（spray）也会被 IP 维度计数拦住', async () => {
        const api = buildApp({ guardEnv: env });

        const names = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'];
        for (const name of names) {
            expect((await api.attempt(name, 'wrong-password')).status).toBe(401);
        }

        // 第 7 次来自新账号：账号维度是干净的，但 IP 维度已累计 6 次
        const seventh = await api.attempt('g7', 'wrong-password');
        expect(seventh.status).toBe(429);
    });

    it('不同出口 IP 的账号锁定相互独立于其它账号', async () => {
        const api = buildApp({ guardEnv: env });

        for (let i = 1; i <= 7; i++) {
            await api.attempt('victim', 'wrong-password', '198.51.100.1');
        }
        expect((await api.attempt('victim', 'wrong-password', '198.51.100.1')).status).toBe(429);

        // 另一个 IP 爆破另一个账号不应受影响（各自的 acct + ip 计数）
        const other = await api.attempt('someone-else', 'wrong-password', '198.51.100.9');
        expect(other.status).toBe(401);
    });

    it('登录 IP 限流：超过 LOGIN_RATE_LIMIT 后 429（不依赖失败与否）', async () => {
        const api = buildApp({ guardEnv: { ...env, LOGIN_RATE_LIMIT: '7', LOGIN_RATE_LIMIT_WINDOW: '60' } as unknown as Env, rateLimit: true });

        // 7 次允许，第 8 次被限流；全部使用正确密码避免触发锁定逻辑
        for (let i = 1; i <= 7; i++) {
            const res = await api.attempt('root', CORRECT_PASSWORD);
            expect(res.status).toBe(200);
        }
        const limited = await api.attempt('root', CORRECT_PASSWORD);
        expect(limited.status).toBe(429);
        const body = await limited.json();
        expect(body.code).toBe(-6);
        expect(body.msg).toContain('请求过于频繁');
    });
});
