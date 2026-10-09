/**
 * JWT 编解码的 UTF-8 安全性
 *
 * 回归背景：signJWT 原用 btoa(JSON.stringify(payload)) 编码，
 * btoa() 只接受 Latin1 —— payload 含中文用户名（如「抹露茶柒」）时
 * 抛 InvalidCharacterError，导致登录/一键登录签发 500。
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { signJWT, authMiddleware } from '../middleware/auth';
import type { Env } from '../types/env';

const SECRET = 'test-jwt-secret-777-abc-def-ghi-jkl';

function makeEnv(): Env {
    return { JWT_SECRET: SECRET } as unknown as Env;
}

/** 旧实现：仅适用于纯 ASCII（此处用于验证向后兼容） */
function legacyBase64Url(data: string): string {
    return btoa(data).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function roundTrip(payload: Record<string, unknown>) {
    const token = await signJWT(payload, SECRET, 60);
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', authMiddleware);
    app.get('*', (c) => c.json({ ok: true, user: c.get('user') }));
    const res = await app.fetch(
        new Request('http://localhost/', { headers: { Authorization: `Bearer ${token}` } }),
        makeEnv(),
    );
    return { token, res };
}

describe('signJWT 非 ASCII payload（UTF-8 安全）', () => {
    it('中文用户名签发不再抛 InvalidCharacterError', async () => {
        await expect(
            signJWT({ id: 'u1', username: '抹露茶柒', role: 'merchant' }, SECRET, 60),
        ).resolves.toEqual(expect.any(String));
    });

    it('中文用户名签发后能被校验，且字段原样还原', async () => {
        const { res } = await roundTrip({ id: 'u1', username: '抹露茶柒', role: 'merchant' });
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.user.username).toBe('抹露茶柒');
        expect(body.user.role).toBe('merchant');
    });

    it('混合字符（中文/emoji/重音/日文）往返一致', async () => {
        const username = '抹露茶柒-émøji🎉-テスト';
        const { res } = await roundTrip({ id: 'u2', username, role: 'admin' });
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.user.username).toBe(username);
    });

    it('非 ASCII 值不会污染签名段（仍为 base64url 字符集）', async () => {
        const token = await signJWT({ username: '抹露茶柒' }, SECRET, 60);
        const parts = token.split('.');
        expect(parts).toHaveLength(3);
        for (const p of parts) {
            expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });
});

describe('signJWT ASCII 向后兼容', () => {
    it('纯 ASCII header 段与旧 btoa 实现字节一致', async () => {
        const token = await signJWT({ id: 'u1' }, SECRET, 60);
        const headerB64 = token.split('.')[0];
        expect(headerB64).toBe(legacyBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    });

    it('纯 ASCII payload 段与旧 btoa 实现字节一致', async () => {
        // 冻结时间不可行，改为比对解码结果与旧实现可解性
        const token = await signJWT({ id: 'u1', role: 'admin' }, SECRET, 60);
        const payloadB64 = token.split('.')[1];
        const decoded = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
        expect(decoded.id).toBe('u1');
        expect(decoded.role).toBe('admin');
        // 旧实现对该 ASCII 段应产出完全相同的字符串
        expect(payloadB64).toBe(legacyBase64Url(JSON.stringify(decoded)));
    });

    it('ASCII token 仍能被校验通过', async () => {
        const { res } = await roundTrip({ id: 'u1', username: 'admin', role: 'admin' });
        expect(res.status).toBe(200);
    });
});
