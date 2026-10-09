/**
 * 商户密码找回路由（无需登录）
 *
 *   POST /api/password-reset/request  — 按邮箱发起找回，向该邮箱发送一次性重置链接
 *   POST /api/password-reset/confirm  — 用链接里的令牌设置新密码
 *
 * 安全设计：
 *  1. 防账号枚举：无论邮箱是否存在，/request 都返回同一句话与同一状态码；
 *  2. 令牌只存摘要、一次性、30 分钟过期、单令牌限次（见 utils/passwordReset.ts 与 0006 迁移）；
 *  3. 邮件统一由 Teaven Email 服务投递（utils/mailer.ts），未配置 API Key 时明确报错而不是静默失败；
 *  4. 发送与校验都挂 IP / 邮箱双维度限流，且每次操作写审计日志。
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { hashPassword } from '../utils/crypto';
import { generateUUIDv7 } from '../utils/uuid';
import { getSiteUrl } from '../utils/site';
import { getRequestLogMeta, logAuditEvent } from '../utils/logging';
import { isJwtSecretMissingError, resolveJwtSecret, JWT_SECRET_MISSING_MSG } from '../utils/jwtSecret';
import {
    generateResetToken,
    hashResetToken,
    isValidResetTokenShape,
    RESET_TOKEN_MAX_ATTEMPTS,
    RESET_TOKEN_TTL_MS,
} from '../utils/passwordReset';
import { isMailerConfigured, sendMail } from '../utils/mailer';
import { buildPasswordResetMail } from '../utils/mailTemplates';
import { getThrottleStore } from '../utils/throttleStore';
import { getClientIp } from '../middleware/rateLimit';

export const passwordResetRouter = new Hono<{ Bindings: Env }>();

/** 统一的"已受理"响应：邮箱存在与否、是否真的发出邮件，对外表现一致（防枚举） */
const GENERIC_ACCEPTED_MSG = '如果该邮箱已注册，我们已发送密码重置链接，请查收（30 分钟内有效）';
/** 令牌失效类错误的统一文案 */
const INVALID_TOKEN_MSG = '链接无效或已过期，请重新发起找回';

/** 邮箱格式校验（与商户资料接口同一套规则） */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** 新密码长度约束（与 /api/merchant/password 保持一致） */
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;

/** 找回请求限流：单 IP / 单邮箱在窗口内的最大次数与窗口秒数 */
const REQUEST_LIMIT = 7;
const REQUEST_WINDOW_SECONDS = 907;

interface UserLookupRow {
    id: string;
    username: string | null;
    email: string | null;
    role: string;
    status: number;
}

interface ResetRow {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: number;
    used_at: number | null;
    attempts: number;
}

/** 解析请求体：同时兼容 JSON 与表单（与商户登录接口保持一致的宽松度） */
async function readBody(c: { req: { header: (n: string) => string | undefined; json: () => Promise<unknown>; parseBody: () => Promise<Record<string, unknown>> } }): Promise<Record<string, unknown>> {
    const contentType = c.req.header('Content-Type') || '';
    if (contentType.includes('application/json')) {
        try {
            const parsed = await c.req.json();
            if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch {
            return {};
        }
        return {};
    }
    try {
        return await c.req.parseBody() as Record<string, unknown>;
    } catch {
        return {};
    }
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** 拼重置链接：站点地址 + /reset-password?token=... */
function buildResetUrl(siteUrl: string, token: string): string {
    const base = (siteUrl || '').replace(/\/$/, '');
    return base + '/reset-password?token=' + encodeURIComponent(token);
}

/**
 * POST /api/password-reset/request
 * 请求体：{ email } （表单字段同名）
 */
passwordResetRouter.post('/request', async (c) => {
    const body = await readBody(c as never);
    const email = asString(body.email).toLowerCase();
    const ip = getClientIp(c);

    if (!email || !EMAIL_RE.test(email)) {
        return c.json({ code: -1, msg: '请输入正确的邮箱地址' });
    }

    // 邮件能力未配置：明确报错，避免"提示已发送但实际没发"
    if (!isMailerConfigured(c.env)) {
        console.error('password reset: TEAVEN_EMAIL_API_KEY is not configured');
        return c.json({ code: -7, msg: '邮件服务未配置，请联系管理员重置密码' }, 503);
    }

    // IP / 邮箱双维度限流
    const store = getThrottleStore(c.env);
    const ipState = await store.increment('pwreset:ip:' + ip, REQUEST_WINDOW_SECONDS);
    const acctState = await store.increment('pwreset:acct:' + email, REQUEST_WINDOW_SECONDS);
    if (ipState.count > REQUEST_LIMIT || acctState.count > REQUEST_LIMIT) {
        const retryAfter = Math.max(
            1,
            Math.ceil((Math.max(ipState.resetAt, acctState.resetAt) - Date.now()) / 1000),
        );
        c.header('Retry-After', String(retryAfter));
        return c.json({ code: -6, msg: '操作过于频繁，请稍后再试', retryAfter }, 429);
    }

    try {
        const secret = resolveJwtSecret(c.env);

        const user = await c.env.DB.prepare(
            'SELECT id, username, email, role, status FROM users WHERE lower(email) = ? AND role = ?'
        ).bind(email, 'merchant').first() as UserLookupRow | null;

        // 账号不存在 / 被禁用：返回与成功一致的响应，不发送邮件（防枚举）
        if (!user || user.status !== 1) {
            return c.json({ code: 0, msg: GENERIC_ACCEPTED_MSG });
        }

        const token = generateResetToken();
        const tokenHash = await hashResetToken(token, secret);
        const now = Date.now();
        const meta = getRequestLogMeta(c.req.raw);

        // 作废该用户此前未使用的令牌，保证同一时间只有最新链接可用
        await c.env.DB.prepare(
            'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
        ).bind(now, user.id).run();

        await c.env.DB.prepare(
            'INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, attempts, ip, user_agent, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)'
        ).bind(
            generateUUIDv7(),
            user.id,
            tokenHash,
            now + RESET_TOKEN_TTL_MS,
            meta.ip || '',
            meta.userAgent || '',
            new Date().toISOString(),
        ).run();

        const siteUrl = await getSiteUrl(c.env, c.req.url);
        const resetUrl = buildResetUrl(siteUrl, token);
        const mail = buildPasswordResetMail({
            siteName: 'Teaven Pay',
            userName: user.username || email,
            resetUrl,
            expiresMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
        });

        const sent = await sendMail(c.env, {
            to: user.email || email,
            subject: mail.subject,
            html: mail.html,
            category: 'VERIFY',
        });

        await logAuditEvent(c.env, {
            userId: user.id,
            action: 'password_reset_requested',
            target: user.id,
            detail: { delivered: sent.ok, reason: sent.ok ? undefined : sent.reason },
            ...meta,
        });

        if (!sent.ok) {
            return c.json({ code: -7, msg: '邮件发送失败，请稍后重试' }, 503);
        }

        return c.json({ code: 0, msg: GENERIC_ACCEPTED_MSG });
    } catch (error) {
        if (isJwtSecretMissingError(error)) {
            console.error('[FATAL] JWT_SECRET 未配置，无法签发密码找回令牌:', error);
            return c.json({ code: -5, msg: JWT_SECRET_MISSING_MSG }, 500);
        }
        console.error('Password reset request error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * POST /api/password-reset/confirm
 * 请求体：{ token, new_password } （表单字段同名）
 */
passwordResetRouter.post('/confirm', async (c) => {
    const body = await readBody(c as never);
    const token = asString(body.token);
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';

    if (!isValidResetTokenShape(token)) {
        return c.json({ code: -1, msg: INVALID_TOKEN_MSG });
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return c.json({ code: -1, msg: '新密码长度不能少于 ' + MIN_PASSWORD_LENGTH + ' 位' });
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
        return c.json({ code: -1, msg: '新密码长度不能超过 ' + MAX_PASSWORD_LENGTH + ' 位' });
    }

    const meta = getRequestLogMeta(c.req.raw);

    try {
        const secret = resolveJwtSecret(c.env);
        const tokenHash = await hashResetToken(token, secret);
        const now = Date.now();

        const row = await c.env.DB.prepare(
            'SELECT id, user_id, token_hash, expires_at, used_at, attempts FROM password_resets WHERE token_hash = ?'
        ).bind(tokenHash).first() as ResetRow | null;

        // 统一失败文案：不区分"不存在 / 已使用 / 已过期"，避免给攻击者额外信息
        if (!row || row.used_at !== null || row.expires_at <= now) {
            return c.json({ code: -1, msg: INVALID_TOKEN_MSG });
        }

        if (row.attempts >= RESET_TOKEN_MAX_ATTEMPTS) {
            return c.json({ code: -1, msg: INVALID_TOKEN_MSG });
        }

        const user = await c.env.DB.prepare(
            'SELECT id, role, status FROM users WHERE id = ? AND role = ?'
        ).bind(row.user_id, 'merchant').first() as { id: string; role: string; status: number } | null;

        if (!user || user.status !== 1) {
            // 用户被删除或禁用：令牌直接作废
            await c.env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').bind(now, row.id).run();
            return c.json({ code: -1, msg: INVALID_TOKEN_MSG });
        }

        const { hash, salt } = await hashPassword(newPassword);

        await c.env.DB.prepare(
            "UPDATE users SET password_hash = ?, salt = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(hash, salt, user.id).run();

        // 一次性消费：当前令牌标记已用，同时作废该用户其余未使用令牌
        await c.env.DB.prepare(
            'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
        ).bind(now, user.id).run();

        await logAuditEvent(c.env, {
            userId: user.id,
            action: 'password_reset_completed',
            target: user.id,
            detail: { reset_id: row.id },
            ...meta,
        });

        return c.json({ code: 0, msg: '密码重置成功，请使用新密码登录' });
    } catch (error) {
        if (isJwtSecretMissingError(error)) {
            console.error('[FATAL] JWT_SECRET 未配置，无法校验密码找回令牌:', error);
            return c.json({ code: -5, msg: JWT_SECRET_MISSING_MSG }, 500);
        }
        console.error('Password reset confirm error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
