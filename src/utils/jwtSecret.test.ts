/**
 * JWT_SECRET 必填（fail-fast）与签发/验证同源校验
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { resolveJwtSecret, isJwtSecretConfigured, isJwtSecretMissingError, JwtSecretMissingError } from './jwtSecret';
import { signJWT, authMiddleware } from '../middleware/auth';
import type { Env } from '../types/env';

const SECRET = 'test-jwt-secret-777-abc-def-ghi-jkl';

function makeEnv(jwtSecret?: string): Env {
    return { JWT_SECRET: jwtSecret } as unknown as Env;
}

describe('resolveJwtSecret', () => {
    it('缺失/空串/纯空白时抛 JwtSecretMissingError', () => {
        expect(() => resolveJwtSecret(undefined)).toThrow(JwtSecretMissingError);
        expect(() => resolveJwtSecret({} as Env)).toThrow(JwtSecretMissingError);
        expect(() => resolveJwtSecret(makeEnv(''))).toThrow(JwtSecretMissingError);
        expect(() => resolveJwtSecret(makeEnv('   '))).toThrow(JwtSecretMissingError);
    });

    it('已配置时返回 trim 后的值', () => {
        expect(resolveJwtSecret(makeEnv(SECRET))).toBe(SECRET);
        expect(resolveJwtSecret(makeEnv('  ' + SECRET + '  '))).toBe(SECRET);
    });
});

describe('isJwtSecretConfigured', () => {
    it('与 resolveJwtSecret 行为一致', () => {
        expect(isJwtSecretConfigured(undefined)).toBe(false);
        expect(isJwtSecretConfigured(makeEnv(''))).toBe(false);
        expect(isJwtSecretConfigured(makeEnv('   '))).toBe(false);
        expect(isJwtSecretConfigured(makeEnv(SECRET))).toBe(true);
    });
});

describe('signJWT + authMiddleware 同源', () => {
    it('签发的 token 能被同一密钥校验通过', async () => {
        const env = makeEnv(SECRET);
        const token = await signJWT({ id: 'u1', role: 'admin' }, resolveJwtSecret(env), 60);

        const app = new Hono<{ Bindings: Env }>();
        app.use('*', authMiddleware);
        app.get('*', (c) => c.json({ ok: true, user: c.get('user') }));

        const res = await app.fetch(
            new Request('http://localhost/', { headers: { Authorization: `Bearer ${token}` } }),
            env,
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.ok).toBe(true);
        expect(body.user.id).toBe('u1');
    });

    it('JWT_SECRET 缺失时 authMiddleware 返回 500（非 401）', async () => {
        const env = makeEnv(undefined);
        const app = new Hono<{ Bindings: Env }>();
        app.use('*', authMiddleware);
        app.get('*', (c) => c.json({ ok: true }));

        const res = await app.fetch(
            new Request('http://localhost/', { headers: { Authorization: 'Bearer x.y.z' } }),
            env,
        );
        expect(res.status).toBe(500);
        const body = await res.json() as any;
        expect(body.code).toBe(-5);
        expect(typeof body.msg).toBe('string');
        expect(body.msg.length).toBeGreaterThan(0);
    });

    it('换一个密钥签发的 token 校验失败 → 401', async () => {
        const env = makeEnv(SECRET);
        const token = await signJWT({ id: 'u1', role: 'admin' }, 'wrong-secret', 60);

        const app = new Hono<{ Bindings: Env }>();
        app.use('*', authMiddleware);
        app.get('*', (c) => c.json({ ok: true }));

        const res = await app.fetch(
            new Request('http://localhost/', { headers: { Authorization: `Bearer ${token}` } }),
            env,
        );
        expect(res.status).toBe(401);
    });
});

describe('isJwtSecretMissingError', () => {
    it('识别 JwtSecretMissingError', () => {
        expect(isJwtSecretMissingError(new JwtSecretMissingError())).toBe(true);
        expect(isJwtSecretMissingError(new Error('other'))).toBe(false);
        expect(isJwtSecretMissingError(null)).toBe(false);
        expect(isJwtSecretMissingError(undefined)).toBe(false);
    });
});
