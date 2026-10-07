/**
 * 公开收银台下单认证
 *
 * 背景：POST /api/pay/cashier 原本无签名无认证，任何人只要知道商户 ID
 * 就能以该商户名义下单（刷单 / 伪造订单 / 把订单当载体）。
 *
 * 方案：两段式凭证
 *   1) 票据 ticket：服务端用商户 API 密钥签发，绑定商户 ID + 随机数 +
 *      过期时间。只有先访问过该商户收银台页面（GET /pay/:merchantId）
 *      的客户端才能拿到。
 *   2) 下单签名 sign：客户端以 ticket 为 HMAC 密钥，对
 *      merchant_id + amount + type + timestamp 签名，服务端校验签名与时间窗。
 *
 * 商户后台直连（服务端对服务端）可省略 ticket，直接用 API 密钥签名，
 * 待签串与 ticket 模式完全一致。
 */

import { hmacSha256 } from './crypto';
import { timingSafeEqual } from './constantTime';

/** 签名协议版本 */
const TICKET_VERSION = 'v1';
/** 票据有效期（毫秒） */
const TICKET_TTL_MS = 600_000;
/** 下单时间戳允许偏差（毫秒） */
export const CASHIER_TIMESTAMP_TOLERANCE_MS = 300_000;

export interface CashierTicketPayload {
    merchantId: string;
    nonce: string;
    expiresAt: number;
}

/**
 * 签发票据
 * 格式: v1.<merchantId>.<nonce>.<expiresAt>.<hmacHex>
 */
export async function issueCashierTicket(merchantId: string, apiKey: string): Promise<{ ticket: string; expiresAt: number }> {
    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const expiresAt = Date.now() + TICKET_TTL_MS;
    const body = [TICKET_VERSION, merchantId, nonce, String(expiresAt)].join('.');
    const signature = await hmacSha256(apiKey, body);
    return { ticket: [body, signature].join('.'), expiresAt };
}

/**
 * 校验票据（商户 ID 是否匹配由调用方比对请求参数）
 */
export async function verifyCashierTicket(ticket: string, apiKey: string): Promise<CashierTicketPayload | null> {
    const parsed = parseTicket(ticket);
    if (!parsed) return null;

    const expected = await hmacSha256(apiKey, parsed.body);
    if (!timingSafeEqual(expected, parsed.signature)) {
        return null;
    }
    if (parsed.expiresAt <= Date.now()) {
        return null;
    }

    return { merchantId: parsed.merchantId, nonce: parsed.nonce, expiresAt: parsed.expiresAt };
}

/** 读取票据过期时间（不验签，仅用于前端提示） */
export function readTicketExpiresAt(ticket: string): number | null {
    const parsed = parseTicket(ticket);
    return parsed ? parsed.expiresAt : null;
}

function parseTicket(ticket: string): { merchantId: string; nonce: string; expiresAt: number; signature: string; body: string } | null {
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 512) {
        return null;
    }
    const parts = ticket.split('.');
    if (parts.length !== 5) return null;

    const version = parts[0];
    const merchantId = parts[1];
    const nonce = parts[2];
    const expiresRaw = parts[3];
    const signature = parts[4];

    if (version !== TICKET_VERSION) return null;
    if (!merchantId || !/^[0-9a-f]{32}$/.test(nonce)) return null;
    if (!/^[0-9a-f]{64}$/.test(signature)) return null;

    const expiresAt = Number(expiresRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

    return {
        merchantId,
        nonce,
        expiresAt,
        signature,
        body: [version, merchantId, nonce, expiresRaw].join('.'),
    };
}

/**
 * 构造收银台下单待签串（字段名排序后拼接，便于各语言实现对齐）
 */
export function buildCashierSignString(params: {
    merchant_id: string;
    amount: string;
    type: string;
    timestamp: string;
    name?: string;
}): string {
    const entries: Record<string, string> = {
        amount: params.amount,
        merchant_id: params.merchant_id,
        timestamp: params.timestamp,
        type: params.type,
    };
    if (params.name) {
        entries.name = params.name;
    }
    return Object.keys(entries)
        .sort()
        .map((key) => key + '=' + entries[key])
        .join('&');
}

/**
 * 校验收银台下单签名
 *
 * @param signingKey 票据模式传 ticket 原文，商户直连模式传 API 密钥
 */
export async function verifyCashierSign(
    params: { merchant_id: string; amount: string; type: string; timestamp: string; name?: string },
    signingKey: string,
    sign: string
): Promise<boolean> {
    if (typeof sign !== 'string') return false;
    const normalized = sign.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) return false;

    const expected = await hmacSha256(signingKey, buildCashierSignString(params));
    return timingSafeEqual(expected, normalized);
}

/**
 * 校验下单时间戳，防止票据/签名被长期重放
 */
export function isTimestampFresh(timestamp: string, toleranceMs: number = CASHIER_TIMESTAMP_TOLERANCE_MS): boolean {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return Math.abs(Date.now() - ts) <= toleranceMs;
}
