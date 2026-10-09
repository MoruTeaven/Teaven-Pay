/**
 * Teaven Email 发信客户端
 *
 * 平台自身不实现 SMTP/邮件投递，统一走自建的 Teaven Email 服务
 * （Cloudflare Workers + 多通道发信），只做一件事：带上 API Key 调用
 * POST {TEAVEN_EMAIL_ENDPOINT}/v1/mail/send。
 *
 * 约束：
 *  1. 未配置 TEAVEN_EMAIL_API_KEY 时视为"邮件能力未启用"，由调用方决定降级策略（不静默假装已发送）；
 *  2. 出站地址一律过 isSafeOutboundUrl（SSRF 防护），与商户 notify_url 同一套规则；
 *  3. 不打印 API Key，也不把邮件正文写进日志。
 */

import type { Env } from '../types/env';
import { isSafeOutboundUrl } from './netSecurity';

/** Teaven Email 默认发信端点（可用 TEAVEN_EMAIL_ENDPOINT 覆盖） */
export const DEFAULT_TEAVEN_EMAIL_ENDPOINT = 'https://email.teaven.email/v1/mail/send';
/** 默认分类：发件账号按分类匹配（逗号分隔，如 "VERIFY,NOTIFY"） */
export const DEFAULT_MAIL_CATEGORY = 'NOTIFY';
/** 单次请求超时（毫秒），避免拖垮 Worker 请求 */
const REQUEST_TIMEOUT_MS = 7000;

export interface SendMailOptions {
    /** 收件人邮箱 */
    to: string;
    /** 邮件主题 */
    subject: string;
    /** 邮件 HTML 正文 */
    html: string;
    /** 纯文本正文（缺省由 Teaven Email 自动从 HTML 生成） */
    text?: string;
    /** 发信分类，默认 NOTIFY */
    category?: string;
}

export interface SendMailResult {
    ok: boolean;
    /** 失败原因（用于日志，不对外返回细节） */
    reason?: string;
    /** Teaven Email 返回的邮件记录 ID */
    mailId?: string;
}

/** 邮件能力是否已启用（配置了 API Key） */
export function isMailerConfigured(env: Env): boolean {
    return Boolean(env.TEAVEN_EMAIL_API_KEY && env.TEAVEN_EMAIL_API_KEY.trim());
}

/** 取发信端点（去掉结尾斜杠） */
export function resolveMailEndpoint(env: Env): string {
    const configured = (env.TEAVEN_EMAIL_ENDPOINT || '').trim().replace(/\/$/, '');
    if (!configured) return DEFAULT_TEAVEN_EMAIL_ENDPOINT;
    // 允许只配置服务根地址，自动补 /v1/mail/send
    return /\/v1\/mail\/send$/.test(configured) ? configured : configured + '/v1/mail/send';
}

/**
 * 通过 Teaven Email 发送一封邮件
 * 不抛异常：失败以 { ok: false, reason } 返回，由调用方决定是否重试或提示。
 */
export async function sendMail(env: Env, options: SendMailOptions): Promise<SendMailResult> {
    if (!isMailerConfigured(env)) {
        return { ok: false, reason: 'not_configured' };
    }

    const endpoint = resolveMailEndpoint(env);

    // 出站安全校验：仅 https、拒绝内网/元数据/别名解析域名，DNS 二次校验
    const guard = await isSafeOutboundUrl(endpoint);
    if (!guard.ok) {
        console.error('mailer: endpoint rejected by outbound guard:', guard.reason);
        return { ok: false, reason: 'unsafe_endpoint' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + env.TEAVEN_EMAIL_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                category: options.category || DEFAULT_MAIL_CATEGORY,
                to: options.to,
                subject: options.subject,
                html: options.html,
                ...(options.text ? { text: options.text } : {}),
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            console.error('mailer: send failed with http status', response.status);
            return { ok: false, reason: 'http_' + response.status };
        }

        const payload = await response.json().catch(() => null) as
            { success?: boolean; data?: { mail_id?: string }; error?: string } | null;

        if (!payload || payload.success !== true) {
            console.error('mailer: send rejected by service:', payload?.error || 'unknown');
            return { ok: false, reason: 'rejected' };
        }

        return { ok: true, mailId: payload.data?.mail_id };
    } catch (error) {
        // 超时（AbortError）与网络错误都归到这里；不把邮件正文写入日志
        console.error('mailer: send error:', error instanceof Error ? error.message : error);
        return { ok: false, reason: 'network_error' };
    } finally {
        clearTimeout(timer);
    }
}
