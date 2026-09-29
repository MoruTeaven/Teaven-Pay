/**
 * 错误处理中间件
 */

import { Context } from 'hono';
import { Env } from '../types/env';

/**
 * 全局错误处理
 */
export function errorHandler(error: Error, c: Context<{ Bindings: Env }>) {
    console.error('Unhandled error:', error);
    
    // 记录错误日志
    logError(c.env, error, c.req);
    
    return c.json({
        code: -5,
        msg: '系统错误，请稍后再试',
        // 开发环境返回错误信息
        ...(c.env.ENVIRONMENT === 'development' ? { error: error.message, stack: error.stack } : {})
    }, 500);
}

/**
 * 记录错误日志
 */
async function logError(env: Env, error: Error, req: Request) {
    try {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        const userAgent = req.headers.get('User-Agent') || 'unknown';
        
        await env.DB.prepare(`
            INSERT INTO operation_logs (action, detail, ip, user_agent, created_at)
            VALUES (?, ?, ?, ?, datetime('now'))
        `).bind(
            'error',
            JSON.stringify({
                message: error.message,
                stack: error.stack,
                url: req.url,
                method: req.method
            }),
            ip,
            userAgent
        ).run();
    } catch (logError) {
        console.error('Failed to log error:', logError);
    }
}

/**
 * 自定义业务错误
 */
export class BusinessError extends Error {
    code: number;
    
    constructor(message: string, code: number = -1) {
        super(message);
        this.code = code;
        this.name = 'BusinessError';
    }
}

/**
 * 参数验证错误
 */
export class ValidationError extends BusinessError {
    constructor(message: string) {
        super(message, -1);
        this.name = 'ValidationError';
    }
}

/**
 * 认证错误
 */
export class AuthError extends BusinessError {
    constructor(message: string = '认证失败') {
        super(message, -2);
        this.name = 'AuthError';
    }
}

/**
 * 权限错误
 */
export class PermissionError extends BusinessError {
    constructor(message: string = '权限不足') {
        super(message, -2);
        this.name = 'PermissionError';
    }
}

/**
 * 资源不存在错误
 */
export class NotFoundError extends BusinessError {
    constructor(message: string = '资源不存在') {
        super(message, -4);
        this.name = 'NotFoundError';
    }
}
