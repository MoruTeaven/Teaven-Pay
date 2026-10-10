/**
 * 认证中间件
 */

import { Context, Next } from 'hono';
import { Env } from '../types/env';
import { isJwtSecretMissingError, resolveJwtSecret, JWT_SECRET_MISSING_MSG } from '../utils/jwtSecret';
import { matchApiKey, readApiKeyFromHeaders } from '../utils/apiKeyAuth';

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
        // 验证 JWT token：密钥来源与签发侧一致（c.env.JWT_SECRET，无 fallback）
        const payload = await verifyJWT(token, resolveJwtSecret(c.env));
        
        if (!payload) {
            return c.json({ code: -2, msg: 'Token 无效或已过期' }, 401);
        }
        
        // 将用户信息添加到上下文
        c.set('user', payload);
        
        await next();
    } catch (error) {
        // JWT_SECRET 缺失属于服务端配置错误：fail-fast 返回 500，
        // 不伪装成 401（否则会被误判为 token 无效，掩盖真正的配置问题）
        if (isJwtSecretMissingError(error)) {
            console.error('[FATAL] JWT_SECRET 未配置，无法校验登录凭证:', error);
            return c.json({ code: -5, msg: JWT_SECRET_MISSING_MSG }, 500);
        }
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
 *
 * 安全整改（任务 t-mukt085p）：
 *   - 密钥来源统一为 api_keys 表，不再比对 users.api_key 旧字段；
 *   - 明文密钥不再从 URL query 读取，只接受 X-API-Key / Authorization 请求头，
 *     避免密钥进入访问日志、CDN 日志与 Referer；
 *   - 密钥比对走常数时间比较，避免时序侧信道。
 */
export async function apiKeyMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
    const pid = c.req.query('pid') || c.req.header('X-PID');
    const apiKey = readApiKeyFromHeaders(c.req.raw.headers);
    
    if (!pid || !apiKey) {
        return c.json({ code: -3, msg: '缺少认证参数' }, 401);
    }
    
    try {
        const merchant = await c.env.DB.prepare(
            'SELECT id, role, status FROM users WHERE id = ? AND role = ?'
        ).bind(pid, 'merchant').first<{ id: string; role: string; status: number }>();
        
        if (!merchant) {
            return c.json({ code: -3, msg: '商户不存在或密钥错误' }, 401);
        }
        
        if (merchant.status !== 1) {
            return c.json({ code: -2, msg: '商户已被封禁' }, 403);
        }
        
        const matched = await matchApiKey(c.env.DB, merchant.id, apiKey);
        if (!matched) {
            return c.json({ code: -3, msg: '商户不存在或密钥错误' }, 401);
        }
        
        // 将用户信息添加到上下文
        c.set('user', merchant);
        
        await next();
    } catch (error) {
        return c.json({ code: -5, msg: '认证失败' }, 500);
    }
}

/**
 * base64url 编解码（UTF-8 安全）
 *
 * 背景：原实现用 btoa(JSON.stringify(payload)) 编码 JWT。btoa() 只接受
 * Latin1 字符，payload 含非 ASCII（如中文用户名「抹露茶柒」）时会抛
 * InvalidCharacterError → 登录/一键登录签发 500。
 * 现统一按字节编解码：先 TextEncoder 取 UTF-8 字节，再逐字节转 base64。
 * 对纯 ASCII 输入，输出与旧实现完全一致（既有 token 继续可用）。
 */

/** UTF-8 字符串 → base64url */
function utf8ToBase64Url(input: string): string {
    return bytesToBase64Url(new TextEncoder().encode(input));
}

/** base64url → UTF-8 字符串 */
function base64UrlToUtf8(input: string): string {
    return new TextDecoder().decode(base64UrlToBytes(input));
}

/** 字节数组 → base64url（分块处理，避免大数组展开爆栈） */
function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** base64url → 字节数组 */
function base64UrlToBytes(input: string): Uint8Array {
    const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * 验证 JWT (HMAC-SHA256)
 */
async function verifyJWT(token: string, secret: string): Promise<any> {
    // secret 由 resolveJwtSecret 保证非空；此处仅为 fail-closed 兜底（空密钥一律拒绝）
    if (!secret) return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const header = JSON.parse(base64UrlToUtf8(parts[0]));
        const payload = JSON.parse(base64UrlToUtf8(parts[1]));

        if (header.alg !== 'HS256') return null;

        const keyData = new TextEncoder().encode(secret);
        const key = await crypto.subtle.importKey(
            'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
        );
        const signature = base64UrlToBytes(parts[2]);
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

/**
 * 签发 JWT (HMAC-SHA256)
 */
export async function signJWT(payload: Record<string, any>, secret: string, expiresIn: number = 86400): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);

    const jwtPayload = {
        ...payload,
        iat: now,
        exp: now + expiresIn,
    };

    const headerB64 = utf8ToBase64Url(JSON.stringify(header));
    const payloadB64 = utf8ToBase64Url(JSON.stringify(jwtPayload));

    const keyData = new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const signatureB64 = bytesToBase64Url(new Uint8Array(signature));

    return `${headerB64}.${payloadB64}.${signatureB64}`;
}
