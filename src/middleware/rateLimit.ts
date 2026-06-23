/**
 * 速率限制中间件
 */

import { Context, Next } from 'hono';
import { Env } from '../types/env';

/**
 * 速率限制中间件
 * 使用 KV 存储请求计数
 */
export async function rateLimitMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const limit = parseInt(c.env.RATE_LIMIT || '100');
    const window = parseInt(c.env.RATE_LIMIT_WINDOW || '60');
    
    const key = `rate_limit:${ip}`;
    
    try {
        // 获取当前计数
        const current = await c.env.CACHE.get(key, 'json') as { count: number; resetAt: number } | null;
        
        const now = Date.now();
        
        if (current && current.resetAt > now) {
            // 在时间窗口内
            if (current.count >= limit) {
                return c.json({
                    code: -6,
                    msg: '请求过于频繁，请稍后再试',
                    retryAfter: Math.ceil((current.resetAt - now) / 1000)
                }, 429);
            }
            
            // 增加计数
            await c.env.CACHE.put(key, JSON.stringify({
                count: current.count + 1,
                resetAt: current.resetAt
            }), {
                expirationTtl: Math.ceil((current.resetAt - now) / 1000)
            });
        } else {
            // 新的时间窗口
            const resetAt = now + window * 1000;
            await c.env.CACHE.put(key, JSON.stringify({
                count: 1,
                resetAt
            }), {
                expirationTtl: window
            });
        }
        
        await next();
    } catch (error) {
        // 如果 KV 出错，放行请求
        console.error('Rate limit error:', error);
        await next();
    }
}

/**
 * IP 白名单检查
 */
export async function ipWhitelistMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
    
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
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
    
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
