import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseAllowedOrigins, resolveAllowedOrigin } from './cors';

/** 任务 t-mukt0879 冒烟：验证 CORS 中间件真实行为（未配置白名单时不返回 ACAO） */
function buildApp(allowedOriginsRaw?: string) {
    const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw);
    const app = new Hono();
    app.use('*', cors({
        origin: (origin) => resolveAllowedOrigin(origin, allowedOrigins),
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        maxAge: 86400,
        credentials: allowedOrigins.length > 0 && !allowedOrigins.includes('*'),
    }));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    return app;
}

describe('CORS 中间件集成冒烟', () => {
    it('未配置 ALLOWED_ORIGINS 时不返回 Access-Control-Allow-Origin', async () => {
        const res = await buildApp(undefined).request('/api/health', {
            headers: { Origin: 'https://evil.example.com' },
        });
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });

    it('配置白名单后，白名单内来源回显该 Origin 并允许凭证', async () => {
        const res = await buildApp('https://pay.example.com').request('/api/health', {
            headers: { Origin: 'https://pay.example.com' },
        });
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://pay.example.com');
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
        expect(res.headers.get('Vary')).toContain('Origin');
    });

    it('配置白名单后，白名单外来源不返回 ACAO', async () => {
        const res = await buildApp('https://pay.example.com').request('/api/health', {
            headers: { Origin: 'https://evil.example.com' },
        });
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('预检请求在白名单内返回允许的方法', async () => {
        const res = await buildApp('https://pay.example.com').request('/api/health', {
            method: 'OPTIONS',
            headers: { Origin: 'https://pay.example.com', 'Access-Control-Request-Method': 'POST' },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
});
