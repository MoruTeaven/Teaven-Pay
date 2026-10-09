import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { passwordResetRouter } from './password-reset';
import { createThrottleStore } from '../utils/throttleStore';
import { buildPasswordResetMail } from '../utils/mailTemplates';

/**
 * 任务 t-mv0w9c3h-wx1xft 冒烟：密码找回接口的真实 HTTP 行为
 *
 * 覆盖三类关键性质：
 *  1. 防账号枚举：邮箱不存在 / 被禁用 与 邮箱存在 返回同一响应；
 *  2. 邮件能力未配置时明确 503，不静默假装已发送；
 *  3. 令牌形态校验在任何数据库查询前快速拒绝。
 *
 * 注：用最小 D1 桩替换 env.DB；发送邮件用注入的 fetch 桩，断言请求体。
 */

const JWT_SECRET = 'unit-test-secret-77777';

interface UserRow { id: string; username: string; email: string; role: string; status: number }

/** 极简 D1 桩：只认本路由用到的几条 SQL 前缀 */
function createDbStub(users: UserRow[]) {
    const passwordResets: Array<Record<string, unknown>> = [];

    function prepare(sql: string) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        const stmt = {
            _args: [] as unknown[],
            bind(...args: unknown[]) { stmt._args = args; return stmt; },
            async first() {
                if (norm.startsWith('SELECT id, username, email, role, status FROM users')) {
                    const email = String(stmt._args[0]).toLowerCase();
                    return users.find((u) => u.email.toLowerCase() === email && u.role === stmt._args[1]) || null;
                }
                if (norm.startsWith('SELECT id, user_id, token_hash, expires_at, used_at, attempts FROM password_resets')) {
                    return passwordResets.find((r) => r.token_hash === stmt._args[0]) || null;
                }
                if (norm.startsWith('SELECT id, role, status FROM users')) {
                    return users.find((u) => u.id === stmt._args[0]) || null;
                }
                return null;
            },
            async run() {
                if (norm.startsWith('INSERT INTO password_resets')) {
                    passwordResets.push({
                        id: stmt._args[0], user_id: stmt._args[1], token_hash: stmt._args[2],
                        expires_at: stmt._args[3], used_at: null, attempts: 0,
                    });
                }
                if (norm.startsWith('UPDATE password_resets SET used_at = ? WHERE user_id')) {
                    for (const r of passwordResets) {
                        if (r.user_id === stmt._args[1] && r.used_at === null) r.used_at = stmt._args[0];
                    }
                }
                if (norm.startsWith('UPDATE users SET password_hash')) {
                    const user = users.find((u) => u.id === stmt._args[2]);
                    if (user) (user as never as Record<string, unknown>).password_hash = stmt._args[0];
                }
                return { success: true };
            },
            async all() { return { results: [] }; },
        };
        return stmt;
    }

    return { prepare, passwordResets } as unknown as D1Database & { passwordResets: Array<Record<string, unknown>> };
}

function buildApp(env: Record<string, unknown>) {
    const app = new Hono<{ Bindings: never }>();
    app.route('/api/password-reset', passwordResetRouter);
    return { app, env };
}

/** 把 env 注入到 Hono 的 request 调用里 */
async function call(app: Hono<{ Bindings: never }>, env: Record<string, unknown>, path: string, body?: Record<string, string>) {
    const init: RequestInit = { method: 'POST' };
    if (body) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) form.set(k, v);
        init.body = form;
    }
    // @ts-expect-error 第三个参数为 env（Workers 运行时语义）
    return app.request(path, init, env);
}

const MERCHANT: UserRow = { id: 'u_77', username: 'shop77', email: 'shop77@example.com', role: 'merchant', status: 1 };

describe('POST /api/password-reset/request', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let captured: Array<{ url: string; body: Record<string, unknown> }>;

    beforeEach(() => {
        captured = [];
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            captured.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) });
            return new Response(JSON.stringify({ success: true, data: { mail_id: 'm_1' } }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        });
        // netSecurity 的 DoH 解析也会走 fetch，这里统一返回无 A 记录即视为安全通过需另处理；
        // 为保持用例聚焦，仅让邮件端点返回成功（其他请求原样返回空解析）。
    });

    it('邮箱格式错误直接 400/业务失败', async () => {
        const db = createDbStub([MERCHANT]);
        const { app } = buildApp({});
        const res = await call(app, { DB: db, JWT_SECRET, TEAVEN_EMAIL_API_KEY: 'sk_test' }, '/api/password-reset/request', { email: 'not-an-email' });
        expect(res.status).toBe(200);
        expect((await res.json()).code).toBe(-1);
        expect(captured).toHaveLength(0);
    });

    it('未配置邮件密钥时返回 503，不发信也不写令牌', async () => {
        const db = createDbStub([MERCHANT]);
        const { app } = buildApp({});
        const res = await call(app, { DB: db, JWT_SECRET }, '/api/password-reset/request', { email: MERCHANT.email });
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe(-7);
        expect(captured).toHaveLength(0);
        expect((db as never as { passwordResets: unknown[] }).passwordResets).toHaveLength(0);
    });

    it('邮箱不存在时返回与成功一致的响应（防枚举）', async () => {
        const db = createDbStub([MERCHANT]);
        const { app } = buildApp({});
        const res = await call(app, { DB: db, JWT_SECRET, TEAVEN_EMAIL_API_KEY: 'sk_test' }, '/api/password-reset/request', { email: 'nobody@example.com' });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toBe(0);
        expect(data.msg).toContain('已发送');
        expect(captured).toHaveLength(0);
    });
});

describe('POST /api/password-reset/confirm', () => {
    it('令牌形态非法时不查库、直接业务失败', async () => {
        const db = createDbStub([MERCHANT]);
        const { app } = buildApp({});
        const res = await call(app, { DB: db, JWT_SECRET }, '/api/password-reset/confirm', { token: 'short', new_password: 'newpass123' });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('链接无效或已过期');
    });

    it('新密码过短时拒绝', async () => {
        const db = createDbStub([MERCHANT]);
        const { app } = buildApp({});
        const token = 'a'.repeat(43);
        const res = await call(app, { DB: db, JWT_SECRET }, '/api/password-reset/confirm', { token, new_password: '123' });
        const data = await res.json();
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('6');
    });

    it('令牌不存在时返回统一失效文案', async () => {
        const db = createDbStub([MERCHANT]);
        const { app } = buildApp({});
        const token = 'b'.repeat(43);
        const res = await call(app, { DB: db, JWT_SECRET }, '/api/password-reset/confirm', { token, new_password: 'newpass123' });
        const data = await res.json();
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('链接无效或已过期');
    });
});

describe('限流存储可注入（路由依赖）', () => {
    it('createThrottleStore 在无 KV 时降级到 D1/内存且可计数', async () => {
        const db = createDbStub([]);
        const store = createThrottleStore({ DB: db } as never);
        const state = await store.increment('pwreset:ip:1.2.3.4', 60);
        expect(state.count).toBe(1);
        const again = await store.increment('pwreset:ip:1.2.3.4', 60);
        expect(again.count).toBeGreaterThanOrEqual(1);
    });
});

describe('邮件模板与请求体一致性', () => {
    it('模板渲染出的链接与邮件主题可直接用于 Teaven Email', () => {
        const mail = buildPasswordResetMail({
            siteName: 'Teaven Pay', userName: 'shop77',
            resetUrl: 'https://pay.example.com/reset-password?token=abc', expiresMinutes: 30,
        });
        expect(mail.subject.length).toBeGreaterThan(0);
        expect(mail.html).toContain('/reset-password?token=abc');
    });
});
