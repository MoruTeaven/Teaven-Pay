/**
 * 订单状态访问凭证
 *
 * 背景（B-3）：`GET /api/pay/status/:tradeNo` 原本完全不校验，
 * 任何人只要拿到平台订单号就能查订单状态与金额（订单号还会出现在
 * 收银台 URL、商户回跳地址里，等同于半公开信息）。
 *
 * 该接口又是收银台页面的轮询端点，浏览器里没有商户密钥，
 * 不能要求它做完整的商户签名，所以引入「单订单票据」：
 *   - 由 `GET /cashier/:tradeNo` 页面在服务端签发，用订单归属商户的主密钥
 *     （`api_keys` 表，与入站验签同源）做 HMAC-SHA256；
 *   - 票据只绑定这一个 tradeNo，拿到票据也查不了别的订单；
 *   - 带过期时间，过期后必须重新打开收银台页面；
 *   - 服务端到服务端场景不依赖票据，仍可用商户 sign 签名查询（见 pay.ts）。
 */

import { hmacSha256 } from './crypto';
import { timingSafeEqual } from './constantTime';

/** 票据协议版本 */
const TOKEN_VERSION = 'v1';
/** 票据有效期（毫秒）：约 13 分钟，覆盖收银台 120 次轮询窗口 */
export const ORDER_STATUS_TOKEN_TTL_MS = 777_000;

export interface OrderStatusTokenPayload {
    tradeNo: string;
    expiresAt: number;
}

/** 签发票据，格式 `v1.<tradeNo>.<expiresAt>.<hmacHex>` */
export async function issueOrderStatusToken(
    tradeNo: string,
    signingKey: string
): Promise<{ token: string; expiresAt: number }> {
    const expiresAt = Date.now() + ORDER_STATUS_TOKEN_TTL_MS;
    const body = [TOKEN_VERSION, tradeNo, String(expiresAt)].join('.');
    const signature = await hmacSha256(signingKey, body);
    return { token: [body, signature].join('.'), expiresAt };
}

/**
 * 校验票据。
 *
 * @param keys 订单归属商户的全部启用密钥；逐一比对且不做命中即返回，
 *             避免通过响应耗时区分命中了第几把密钥。
 */
export async function verifyOrderStatusToken(
    token: string | null | undefined,
    tradeNo: string,
    keys: string[]
): Promise<boolean> {
    const parsed = parseOrderStatusToken(token);
    if (!parsed) return false;
    // 票据必须是本订单的，防止一张票据用于查询任意订单
    if (parsed.tradeNo !== tradeNo) return false;
    if (parsed.expiresAt <= Date.now()) return false;
    if (keys.length === 0) return false;

    let matched = false;
    for (const key of keys) {
        const expected = await hmacSha256(key, parsed.body);
        if (timingSafeEqual(expected, parsed.signature)) {
            matched = true;
        }
    }
    return matched;
}

/** 读取票据过期时间（不验签，仅用于前端提示） */
export function readOrderStatusTokenExpiresAt(token: string | null | undefined): number | null {
    return parseOrderStatusToken(token)?.expiresAt ?? null;
}

function parseOrderStatusToken(
    token: string | null | undefined
): { tradeNo: string; expiresAt: number; signature: string; body: string } | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;

    const parts = token.split('.');
    if (parts.length !== 4) return null;

    const [version, tradeNo, expiresRaw, signature] = parts;
    if (version !== TOKEN_VERSION) return null;
    if (!tradeNo) return null;
    if (!/^[0-9a-f]{64}$/.test(signature)) return null;

    const expiresAt = Number(expiresRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

    return {
        tradeNo,
        expiresAt,
        signature,
        body: [version, tradeNo, expiresRaw].join('.'),
    };
}
