/**
 * Teaven Email 发信客户端
 *
 * 平台自身不实现 SMTP/邮件投递，统一走自建的 Teaven Email 服务
 * （Cloudflare Workers + 多通道发信）。这里只做三件事：
 *  1. 用官方 SDK @moruteaven/email 组装并发送请求；
 *  2. 发送前对目标地址做 SSRF 校验（SDK 不含该能力，见 netSecurity.ts）；
 *  3. 把 SDK 抛出的结构化错误收敛成不抛异常的 { ok, reason } 结果。
 *
 * 约束：
 *  1. 未配置 TEAVEN_EMAIL_API_KEY 时视为"邮件能力未启用"，由调用方决定降级策略（不静默假装已发送）；
 *  2. 出站地址一律过 isSafeOutboundUrl（SSRF 防护），与商户 notify_url 同一套规则；
 *  3. 不打印 API Key，也不把邮件正文写进日志。
 */

import { TeavenEmail, TeavenError, type TemplateCategory } from '@moruteaven/email';
import type { Env } from '../types/env';
import { isSafeOutboundUrl } from './netSecurity';

/** Teaven Email 默认服务地址（可用 TEAVEN_EMAIL_BASE_URL / TEAVEN_EMAIL_ENDPOINT 覆盖） */
export const DEFAULT_TEAVEN_EMAIL_BASE_URL = 'https://email.chenyande.com';
/** 默认分类：发件账号按分类匹配（逗号分隔，如 "VERIFY,NOTIFY"） */
export const DEFAULT_MAIL_CATEGORY: TemplateCategory = 'NOTIFY';
/** 单次请求超时（毫秒），避免拖垮 Worker 请求 */
export const MAIL_REQUEST_TIMEOUT_MS = 7000;

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
    category?: TemplateCategory;
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

/**
 * 取发信服务根地址（去掉结尾斜杠与可能残留的接口路径）。
 * 历史配置里可能写成 ".../v1/mail/send"，SDK 需要的是根地址，这里一并兼容。
 */
export function resolveMailBaseUrl(env: Env): string {
    const configured = (env.TEAVEN_EMAIL_BASE_URL || env.TEAVEN_EMAIL_ENDPOINT || '').trim();
    const base = configured ? configured : DEFAULT_TEAVEN_EMAIL_BASE_URL;
    return base.replace(/\/v1\/mail\/send\/?$/, '').replace(/\/+$/, '');
}

/** 把 SDK 的结构化错误映射成稳定的原因码（只用于日志与审计，不外泄细节） */
function reasonFromError(error: unknown): string {
    if (error instanceof TeavenError) return error.code;
    return 'unknown_error';
}

/**
 * 通过 Teaven Email 发送一封邮件
 * 不抛异常：失败以 { ok: false, reason } 返回，由调用方决定是否重试或提示。
 */
export async function sendMail(env: Env, options: SendMailOptions): Promise<SendMailResult> {
    if (!isMailerConfigured(env)) {
        return { ok: false, reason: 'not_configured' };
    }

    const baseUrl = resolveMailBaseUrl(env);

    // 出站安全校验：仅 https、拒绝内网/元数据/别名解析域名，DNS 二次校验
    const guard = await isSafeOutboundUrl(baseUrl);
    if (!guard.ok) {
        console.error('mailer: endpoint rejected by outbound guard:', guard.reason);
        return { ok: false, reason: 'unsafe_endpoint' };
    }

    let client: TeavenEmail;
    try {
        client = new TeavenEmail({
            apiKey: (env.TEAVEN_EMAIL_API_KEY || '').trim(),
            baseUrl,
            timeoutMs: MAIL_REQUEST_TIMEOUT_MS,
        });
    } catch (error) {
        // 例如 Key 缺少 sk_ 前缀：属于配置错误，明确区分于发送失败
        console.error('mailer: client init failed:', error instanceof Error ? error.message : error);
        return { ok: false, reason: reasonFromError(error) };
    }

    try {
        // 发信类接口不做自动重试（服务端无幂等键，重试会重复投递），SDK 已保证该行为
        const data = await client.mail.send({
            to: options.to,
            subject: options.subject,
            html: options.html,
            ...(options.text ? { text: options.text } : {}),
            category: options.category || DEFAULT_MAIL_CATEGORY,
        });

        // SDK 已把服务端的 mail_id 规范化为 mailId
        return { ok: true, mailId: data.mailId };
    } catch (error) {
        // 超时、网络错误、HTTP 错误都在这里收敛；不把邮件正文写入日志
        console.error('mailer: send failed:', reasonFromError(error));
        return { ok: false, reason: reasonFromError(error) };
    }
}
