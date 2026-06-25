/**
 * 认证中间件
 */

import { Context, Next } from 'hono';
import { Env } from '../types/env';

/**
 * JWT 认证中间件
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ code: -2, msg: '未授权访问' }, 401);
    }
    
    const token = authHeader.substring(7);
    
    try {
        // 验证 JWT token
        // TODO: 实现 JWT 验证
        const payload = await verifyJWT(token, c.env.JWT_SECRET || '');
        
        if (!payload) {
            return c.json({ code: -2, msg: 'Token 无效或已过期' }, 401);
        }
        
        // 将用户信息添加到上下文
        c.set('user', payload);
        
        await next();
    } catch (error) {
        return c.json({ code: -2, msg: '认证失败' }, 401);
    }
}

/**
 * 管理员权限中间件
 */
export async function adminMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const user = c.get('user');
    
    if (!user || user.role !== 'admin') {
        return c.json({ code: -2, msg: '需要管理员权限' }, 403);
    }
    
    await next();
}

/**
 * 商户权限中间件
 */
export async function merchantMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const user = c.get('user');
    
    if (!user || (user.role !== 'merchant' && user.role !== 'admin')) {
        return c.json({ code: -2, msg: '需要商户权限' }, 403);
    }
    
    await next();
}

/**
 * API Key 认证中间件
 */
export async function apiKeyMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const pid = c.req.query('pid') || c.req.header('X-PID');
    const apiKey = c.req.query('key') || c.req.header('X-API-Key');
    
    if (!pid || !apiKey) {
        return c.json({ code: -3, msg: '缺少认证参数' }, 401);
    }
    
    try {
        // 查询商户
        const user = await c.env.DB.prepare(
            'SELECT id, role, status FROM users WHERE id = ? AND api_key = ? AND role = ?'
        ).bind(pid, apiKey, 'merchant').first();
        
        if (!user) {
            return c.json({ code: -3, msg: '商户不存在或密钥错误' }, 401);
        }
        
        if (user.status !== 1) {
            return c.json({ code: -2, msg: '商户已被封禁' }, 403);
        }
        
        // 将用户信息添加到上下文
        c.set('user', user);
        
        await next();
    } catch (error) {
        return c.json({ code: -5, msg: '认证失败' }, 500);
    }
}

/**
 * 验证 JWT (HMAC-SHA256)
 */
async function verifyJWT(token: string, secret: string): Promise<any> {
    if (!secret) return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

        if (header.alg !== 'HS256') return null;

        const keyData = new TextEncoder().encode(secret);
        const key = await crypto.subtle.importKey(
            'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
        );
        const signature = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const valid = await crypto.subtle.verify('HMAC', key, signature, data);
        if (!valid) return null;

        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) return null;
        if (payload.nbf && payload.nbf > now) return null;

        return payload;
    } catch {
        return null;
    }
}
