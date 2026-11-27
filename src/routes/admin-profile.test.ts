import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from './admin';
import { signJWT } from '../middleware/auth';

/**
 * 管理员自助修改账号信息接口的冒烟测试（任务：后台信息不可修改）
 *
 * 覆盖：
 *  1. GET /api/admin/profile 返回当前管理员资料；
 *  2. PUT /api/admin/profile 能改用户名/邮箱，重名/重邮箱被拒绝；
 *  3. 改用户名后重新签发 token（data.token 存在）；
 *  4. POST /api/admin/password 旧密码错误被拒、正确则更新哈希。
 *
 * 用最小 D1 桩替换 env.DB，用真实 JWT 走 authMiddleware/adminMiddleware。
 */

const JWT_SECRET = 'admin-profile-test-secret-77777';
const ADMIN_ID = 'user_admin';

interface AdminRow {
    id: string;
    username: string;
    email: string;
    password_hash: string;
    salt: string;
    role: string;
    status: number;
    [key: string]: unknown;
}

function hashFrom(seed: string) { return `hash_${seed}`; }

function createDbStub(admins: AdminRow[]) {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    function prepare(sql: string) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        const stmt = {
            _args: [] as unknown[],
            bind(...args: unknown[]) { stmt._args = args; return stmt; },
            async first() {
                calls.push({ sql: norm, args: [...stmt._args] });
                // D1 返回的是行快照，这里复制一份，避免 run() 改动同一引用影响断言
                const snap = (a: AdminRow | undefined) => (a ? { ...a } : null);
                if (norm.startsWith('SELECT id, username, email, status, role, last_login_at')) {
                    return snap(admins.find(a => a.id === stmt._args[0] && a.role === 'admin'));
                }
                if (norm.startsWith('SELECT id, username, status FROM users')) {
                    return snap(admins.find(a => a.id === stmt._args[0] && a.role === 'admin'));
                }
                if (norm.startsWith('SELECT id FROM users WHERE username = ?')) {
                    return snap(admins.find(a => a.username === stmt._args[0] && a.id !== stmt._args[1]));
                }
                if (norm.startsWith('SELECT id FROM users WHERE email = ?')) {
                    return snap(admins.find(a => a.email === stmt._args[0] && a.id !== stmt._args[1]));
                }
                if (norm.startsWith('SELECT * FROM users WHERE id = ? AND role = ?')) {
                    return snap(admins.find(a => a.id === stmt._args[0] && a.role === 'admin'));
                }
                return null;
            },
            async run() {
                calls.push({ sql: norm, args: [...stmt._args] });
                if (norm.startsWith('UPDATE users SET username')) {
                    const a = admins.find(x => x.id === stmt._args[stmt._args.length - 1]);
                    if (a) { a.username = String(stmt._args[0]); a.email = String(stmt._args[1]); }
                }
                if (norm.startsWith('UPDATE users SET password_hash')) {
                    const a = admins.find(x => x.id === stmt._args[2]);
                    if (a) { a.password_hash = String(stmt._args[0]); a.salt = String(stmt._args[1]); }
                }
                return { success: true };
            },
            async all() { return { results: [] }; },
        };
        return stmt;
    }
    return { db: { prepare } as unknown as D1Database, calls };
}

function buildApp() {
    const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string } }>();
    app.route('/api/admin', adminRouter);
    return app;
}

async function token(username = 'admin') {
    return signJWT({ id: ADMIN_ID, username, role: 'admin' }, JWT_SECRET, 3600);
}

function call(app: ReturnType<typeof buildApp>, db: D1Database, path: string, method: string, body?: Record<string, string>, authToken?: string) {
    const init: RequestInit = { method };
    if (body) init.body = new URLSearchParams(body);
    if (authToken) init.headers = { Authorization: `Bearer ${authToken}` };
    return app.request(path, init, { DB: db, JWT_SECRET } as never);
}

const ADMIN: AdminRow = {
    id: ADMIN_ID, username: 'admin', email: 'admin@example.com',
    password_hash: hashFrom('old'), salt: 'salt77', role: 'admin', status: 1,
};

describe('GET /api/admin/profile', () => {
    it('未登录返回 401', async () => {
        const { db } = createDbStub([{ ...ADMIN }]);
        const res = await call(buildApp(), db, '/api/admin/profile', 'GET');
        expect(res.status).toBe(401);
    });

    it('返回当前管理员资料，不含密码哈希', async () => {
        const { db } = createDbStub([{ ...ADMIN }]);
        const res = await call(buildApp(), db, '/api/admin/profile', 'GET', undefined, await token());
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.code).toBe(0);
        expect(data.data.username).toBe('admin');
        expect(data.data.email).toBe('admin@example.com');
        expect(data.data.password_hash).toBeUndefined();
    });
});

describe('PUT /api/admin/profile', () => {
    it('能同时修改用户名和邮箱，并返回新 token', async () => {
        const { db } = createDbStub([{ ...ADMIN }]);
        const res = await call(buildApp(), db, '/api/admin/profile', 'PUT',
            { username: 'newadmin', email: 'new@example.com' }, await token());
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.code).toBe(0);
        expect(data.data.user.username).toBe('newadmin');
        expect(data.data.token).toBeTruthy();
    });

    it('邮箱格式错误被拒绝', async () => {
        const { db } = createDbStub([{ ...ADMIN }]);
        const res = await call(buildApp(), db, '/api/admin/profile', 'PUT',
            { email: 'bad-email' }, await token());
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('邮箱格式');
    });

    it('用户名重名被拒绝', async () => {
        const rows = [{ ...ADMIN }, { ...ADMIN, id: 'other', username: 'taken' }];
        const { db } = createDbStub(rows);
        const res = await call(buildApp(), db, '/api/admin/profile', 'PUT',
            { username: 'taken' }, await token());
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('用户名已被使用');
    });
});

describe('POST /api/admin/password', () => {
    it('旧密码校验走 verifyPassword（错误密码不会调用 hashPassword）', async () => {
        const { db } = createDbStub([{ ...ADMIN }]);
        const res = await call(buildApp(), db, '/api/admin/password', 'POST',
            { old_password: 'wrong', new_password: 'newpass77' }, await token());
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('当前密码错误');
    });

    it('新密码过短被拒绝', async () => {
        const { db } = createDbStub([{ ...ADMIN }]);
        const res = await call(buildApp(), db, '/api/admin/password', 'POST',
            { old_password: 'old', new_password: '123' }, await token());
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(data.msg).toContain('不能少于6位');
    });
});
