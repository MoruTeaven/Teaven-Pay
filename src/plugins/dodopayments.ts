/**
 * DodoPayments 支付插件（一次性支付 / hosted checkout）
 *
 * 官方文档：https://docs.dodopayments.com
 *  - 建单：POST /checkouts（旧 POST /payments 已废弃）
 *  - 查单：GET /payments/{payment_id}
 *  - 退款：POST /refunds、GET /refunds/{refund_id}
 *  - Webhook：Standard Webhooks（HMAC-SHA256）
 *
 * 运行于 Cloudflare Workers，全程原生 fetch + Web Crypto，不依赖 Node API。
 *
 * 金额口径：Dodo 一律用货币最小单位（USD 分），本系统订单金额是「元」，
 * 因此下发时 Math.round(amount * 100)，回调/查单回来时 /100。
 *
 * 金额必须精确锁定：要求后台配置的 product_id 是开启了 Pay What You Want
 * （PWYW）的一次性产品；普通固定价产品会忽略 amount，导致买家少付。
 */

import {
    PaymentPlugin,
    OrderInfo,
    PluginConfig,
    PaymentResult,
    NotifyResult,
    OrderStatus,
    RefundResult,
    RefundStatus
} from '../types/plugin';
import { generateRefundNo } from '../utils/uuid';
import { timingSafeEqual } from '../utils/constantTime';
import { DODO_PAYMENT_TYPE_NAMES, normalizeDodoMethodTypes } from './dodopayments-methods';

const TEST_BASE = 'https://test.dodopayments.com';
const LIVE_BASE = 'https://live.dodopayments.com';

/** webhook 时间戳容忍窗口（秒），Standard Webhooks 默认 5 分钟 */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/** 默认币种：PWYW 产品只支持 USD/GBP/EUR，未配置时按 USD 处理 */
const DEFAULT_CURRENCY = 'USD';

interface DodoConfig extends PluginConfig {
    /** API Key：dodo_test_... / dodo_live_... */
    apiKey?: string;
    /** 支付方式 id（兼容旧配置写法） */
    productId?: string;
    /** Dodo 产品 ID（需开启 Pay What You Want） */
    product_id?: string;
    /** ISO 4217 币种，默认 USD */
    currency?: string;
    /** 强制使用某环境：test / live；不填则按 apiKey 前缀自动判断 */
    environment?: string;
    /** Webhook 验签密钥（whsec_...） */
    webhookSecret?: string;
    /** 后台主动查单/退款超时（毫秒） */
    timeoutMs?: number | string;
    /** 开发者下单传入的同步回跳地址（由 pay.ts 合并进 config） */
    returnUrl?: string;
    /**
     * 本通道提供给用户的支付方式白名单（Dodo method code）。
     * 来源：payment_types.name 对应的 channel.config.payment_method_type。
     * 未配置时不传 allowed_payment_method_types，由 Dodo 按其规则自动展示。
     */
    payment_method_type?: string | string[];
    /** 是否额外放行信用卡/借记卡兜底（默认 false，严格只展示所选方式） */
    allowCardFallback?: boolean | string;
}

interface DodoApiError {
    code?: string;
    message?: string;
}

/** 按 API Key 前缀选择环境，避免 test key 打到 live 域名（会 401） */
function resolveBase(config: DodoConfig): string {
    const env = String(config.environment || '').toLowerCase();
    if (env === 'test' || env === 'sandbox') return TEST_BASE;
    if (env === 'live' || env === 'production') return LIVE_BASE;
    if (String(config.apiKey || config.appSecret || '').startsWith('dodo_test_')) return TEST_BASE;
    return LIVE_BASE;
}

/** 兼容 appSecret（后台通用字段）与 apiKey 两种配置写法 */
function resolveApiKey(config: DodoConfig): string {
    return config.apiKey || config.appSecret || '';
}

function resolveProductId(config: DodoConfig): string {
    return config.product_id || config.productId || config.appId || '';
}

function toMinorUnits(amount: number): number {
    return Math.round(Number(amount) * 100);
}

function fromMinorUnits(amount: unknown): number | undefined {
    const n = Number(amount);
    if (!Number.isFinite(n) || amount === null || amount === undefined || amount === '') return undefined;
    return n / 100;
}

/** b64 <-> Uint8Array（Web Crypto 在 Workers 中可用） */
function base64ToBytes(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/**
 * Standard Webhooks 验签：
 *   signedContent = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *   signature = base64(HMAC-SHA256(base64decode(secret without whsec_), signedContent))
 * webhook-signature 可能有多个 `v1,<sig>`，任一匹配即通过。
 */
async function verifyWebhookSignature(
    rawBody: string,
    id: string,
    timestamp: string,
    signatureHeader: string,
    secret: string
): Promise<boolean> {
    if (!id || !timestamp || !signatureHeader || !secret) return false;

    const tsSeconds = Number(timestamp);
    if (!Number.isFinite(tsSeconds)) return false;
    if (Math.abs(Date.now() / 1000 - tsSeconds) > WEBHOOK_TOLERANCE_SECONDS) return false;

    const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    let keyBytes: Uint8Array;
    try {
        keyBytes = base64ToBytes(rawSecret);
    } catch {
        return false;
    }

    try {
        const key = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
        const mac = await crypto.subtle.sign('HMAC', key, signed);
        const expected = bytesToBase64(new Uint8Array(mac));

        const candidates = signatureHeader
            .split(' ')
            .map((part) => part.trim())
            .filter((part) => part.startsWith('v1,'))
            .map((part) => part.slice(3));
        return candidates.some((candidate) => timingSafeEqual(candidate, expected));
    } catch {
        return false;
    }
}

/** 统一解析 Dodo 响应与错误，避免把原始错误体直接暴露给商户 */
async function readResponse(response: Response): Promise<{ ok: boolean; data: any; error?: DodoApiError }> {
    const text = await response.text();
    let data: any = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        return { ok: false, data: null, error: { message: '渠道返回非法 JSON' } };
    }
    if (response.ok) return { ok: true, data };
    return {
        ok: false,
        data,
        error: {
            code: data?.code,
            message: data?.message || `渠道返回 HTTP ${response.status}`
        }
    };
}

/** Dodo 支付状态 → 本系统状态。注意 Dodo 没有 pending/refunded 这两个 payment status。 */
function mapPaymentStatus(status: string): OrderStatus['status'] {
    switch (status) {
        case 'succeeded':
            return 'paid';
        case 'failed':
        case 'cancelled':
            return 'closed';
        default:
            // processing / requires_* / partially_* 均视为处理中
            return 'pending';
    }
}

function mapRefundStatus(status: string): RefundStatus['status'] {
    switch (status) {
        case 'succeeded':
            return 'success';
        case 'failed':
            return 'failed';
        default:
            return 'processing';
    }
}

export class DodoPaymentsPlugin implements PaymentPlugin {
    id = 'dodopayments';
    name = 'DodoPayments';
    version = '1.1.0';
    /**
     * 用户侧支付方式（payment_types.name）→ 本插件。
     * 后台按 name 匹配插件，必须把全部 Dodo 支付方式列出，
     * 否则在后台为这些支付方式建通道时插件下拉无法选中。
     */
    supportedTypes = DODO_PAYMENT_TYPE_NAMES;

    private request(config: DodoConfig, path: string, init?: RequestInit): Promise<Response> {
        const apiKey = resolveApiKey(config);
        const timeout = Number(config.timeoutMs) || 15000;
        return fetch(`${resolveBase(config)}${path}`, {
            ...init,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                ...(init?.headers || {})
            },
            signal: AbortSignal.timeout(timeout)
        });
    }

    /**
     * 创建支付：POST /checkouts，返回 hosted checkout URL 供前端跳转。
     * metadata 携带平台订单号，webhook 据此定位订单。
     */
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        try {
            const cfg = config as DodoConfig;
            const apiKey = resolveApiKey(cfg);
            const productId = resolveProductId(cfg);
            if (!apiKey || !productId) {
                return { success: false, method: 'jump', message: 'DodoPayments 配置不完整' };
            }

            const body: Record<string, any> = {
                product_cart: [
                    {
                        product_id: productId,
                        quantity: 1,
                        // PWYW 产品必传；普通产品会被 Dodo 忽略
                        amount: toMinorUnits(order.amount)
                    }
                ],
                metadata: {
                    trade_no: order.tradeNo,
                    out_trade_no: order.outTradeNo
                }
            };

            const currency = String(cfg.currency || DEFAULT_CURRENCY).toUpperCase();
            if (currency && currency !== DEFAULT_CURRENCY) {
                body.billing_currency = currency;
            }

            // 限定本通道允许的支付方式：只把该 payment_type 对应的 Dodo method
            // 传给 Dodo，让 hosted checkout 只展示用户选的那一种。
            const methods = normalizeDodoMethodTypes(cfg.payment_method_type);
            if (methods.length > 0) {
                let allowed = methods;
                const fallback = cfg.allowCardFallback === true || cfg.allowCardFallback === 'true';
                if (fallback) {
                    allowed = Array.from(new Set([...methods, 'credit', 'debit']));
                }
                body.allowed_payment_method_types = allowed;
            }

            // 同步回跳：优先使用开发者下单传入的 return_url（pay.ts 已合并到 config）
            if (cfg.returnUrl) body.return_url = cfg.returnUrl;

            const response = await this.request(cfg, '/checkouts', {
                method: 'POST',
                body: JSON.stringify(body)
            });
            const { ok, data, error } = await readResponse(response);
            if (!ok || !data?.session_id) {
                return {
                    success: false,
                    method: 'jump',
                    message: error?.message || 'DodoPayments 创建支付失败'
                };
            }

            const checkoutUrl = String(data.checkout_url || '');
            if (!checkoutUrl) {
                return { success: false, method: 'jump', message: 'DodoPayments 未返回支付链接' };
            }

            return {
                success: true,
                method: 'jump',
                payUrl: checkoutUrl,
                // 回传会话号，由路由层落到 orders.api_trade_no，
                // 后续查询/退款靠它定位 Dodo 侧资源。
                externalTradeNo: String(data.session_id)
            };
        } catch (error: any) {
            return {
                success: false,
                method: 'jump',
                message: error?.message || 'DodoPayments 创建支付失败'
            };
        }
    }

    /**
     * 异步通知：Standard Webhooks 验签。
     *
     * 由于通用通知路由只解析 JSON body、拿不到 raw body 与 header，
     * 这里要求 payload 携带 `__raw`（原始字符串）与 `__headers`，
     * 由 DodoPayments 专用通知路由注入（见 src/routes/notify.ts）。
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        const fail = (errorCode: string, message: string): NotifyResult => ({
            success: false,
            tradeNo: '',
            outTradeNo: '',
            status: 'failed',
            errorCode,
            message,
            response: 'fail'
        });

        try {
            const cfg = config as DodoConfig;
            const webhookSecret = cfg.webhookSecret || '';
            if (!webhookSecret) return fail('VERIFY_NO_SECRET', '缺少 Webhook 验签密钥');

            const raw = payload?.__raw;
            const headers = payload?.__headers || {};
            if (typeof raw !== 'string') return fail('VERIFY_NO_RAW', '缺少原始回调内容');

            const id = String(headers['webhook-id'] || '');
            const timestamp = String(headers['webhook-timestamp'] || '');
            const signature = String(headers['webhook-signature'] || '');
            const ok = await verifyWebhookSignature(raw, id, timestamp, signature, webhookSecret);
            if (!ok) return fail('VERIFY_FAILED', '回调验签失败');

            const event = JSON.parse(raw) as {
                type?: string;
                data?: Record<string, any> & { payment_id?: string; total_amount?: number };
            };
            const eventType = String(event.type || '');
            const data = event.data || {};
            const paymentId = String(data.payment_id || '');

            // 只处理支付相关事件；其它事件（订阅/退款/争议等）不驱动入账
            if (!eventType.startsWith('payment.')) {
                return {
                    success: true,
                    tradeNo: '',
                    outTradeNo: '',
                    status: 'pending',
                    response: 'success'
                };
            }

            // 平台订单号编码在 metadata.trade_no；Dodo 的 metadata 直接位于事件 data 中。
            // 若 checkout metadata 未传播到 payment，回退到路由层按 checkout_session_id 查到的订单号。
            const tradeNo = String(
                data.metadata?.trade_no ||
                data.trade_no ||
                (cfg as any).__tradeNoHint ||
                ''
            );
            if (!tradeNo) return fail('NO_TRADE_NO', '回调缺少平台订单号');

            // 退款类事件绝不能被当作付款成功（total_amount 可能仍是原订单金额）
            const isPaid = eventType === 'payment.succeeded';
            const paidAmount = fromMinorUnits(data.total_amount);

            return {
                success: true,
                tradeNo,
                outTradeNo: String(data.metadata?.out_trade_no || (cfg as any).__outTradeNoHint || tradeNo),
                thirdPartyTradeNo: paymentId || undefined,
                status: isPaid ? 'success' : (eventType === 'payment.failed' ? 'failed' : 'pending'),
                paidAmount,
                buyer: data.customer?.email || undefined,
                paidAt: data.created_at || undefined,
                response: 'success'
            };
        } catch (error: any) {
            return fail('VERIFY_ERROR', error?.message || '回调处理异常');
        }
    }

    /**
     * 查询订单状态：优先按 payment_id 查 GET /payments/{id}；
     * 尚无 payment_id 时按 checkout session 查 GET /checkouts/{id}。
     */
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus> {
        try {
            const cfg = config as DodoConfig;
            const externalNo = String((cfg as any).externalTradeNo || '');
            if (!externalNo) return { status: 'pending' };

            const isPaymentId = externalNo.startsWith('pay_');
            const path = isPaymentId ? `/payments/${encodeURIComponent(externalNo)}` : `/checkouts/${encodeURIComponent(externalNo)}`;
            const response = await this.request(cfg, path, { method: 'GET' });
            const { ok, data } = await readResponse(response);
            if (!ok || !data) return { status: 'pending' };

            if (isPaymentId) {
                const status = mapPaymentStatus(String(data.status || ''));
                // Dodo 用独立 refund_status 表示退款，不占用 payment status
                if (data.refund_status || Array.isArray(data.refunds) && data.refunds.length > 0) {
                    return { status: 'refunded', thirdPartyTradeNo: data.payment_id };
                }
                return {
                    status,
                    thirdPartyTradeNo: data.payment_id,
                    paidAmount: fromMinorUnits(data.total_amount),
                    buyer: data.customer?.email,
                    paidAt: data.created_at
                };
            }

            // Checkout Session：客户还在填表时 payment_id 为 null
            const paymentId = data.payment_id || '';
            if (!paymentId) {
                return {
                    status: 'pending',
                    paidAmount: fromMinorUnits(data.total_amount)
                };
            }

            const paymentResponse = await this.request(cfg, `/payments/${encodeURIComponent(String(paymentId))}`, { method: 'GET' });
            const paymentResult = await readResponse(paymentResponse);
            if (!paymentResult.ok || !paymentResult.data) {
                return { status: 'pending', thirdPartyTradeNo: String(paymentId) };
            }
            const payment = paymentResult.data;
            return {
                status: mapPaymentStatus(String(payment.status || '')),
                thirdPartyTradeNo: payment.payment_id,
                paidAmount: fromMinorUnits(payment.total_amount),
                buyer: payment.customer?.email,
                paidAt: payment.created_at
            };
        } catch {
            return { status: 'pending' };
        }
    }

    /**
     * 申请退款：POST /refunds，payment_id 必填。
     * 退款金额在 Dodo 侧通过 items 指定；PWYW 产品没有稳定的 item_id，
     * 因此这里只支持全额退款，部分退款明确拒绝（避免退错金额）。
     */
    async refund(order: OrderInfo, amount: number, config: PluginConfig): Promise<RefundResult> {
        try {
            const cfg = config as DodoConfig;
            const apiKey = resolveApiKey(cfg);
            if (!apiKey) return { success: false, message: 'DodoPayments 配置不完整' };

            const paymentId = String((order as any).apiTradeNo || (cfg as any).externalTradeNo || '');
            if (!paymentId.startsWith('pay_')) {
                return {
                    success: false,
                    message: '缺少 DodoPayments 支付单号，无法退款（请确认支付回调已入账）'
                };
            }

            const fullAmount = toMinorUnits(Number(order.actualAmount || order.amount));
            const refundAmount = toMinorUnits(amount);
            if (refundAmount < fullAmount) {
                return {
                    success: false,
                    message: 'DodoPayments 暂不支持部分退款，请按订单全额退款'
                };
            }

            const refundNo = generateRefundNo();
            const response = await this.request(cfg, '/refunds', {
                method: 'POST',
                body: JSON.stringify({
                    payment_id: paymentId,
                    reason: 'merchant refund',
                    metadata: { refund_no: refundNo }
                })
            });
            const { ok, data, error } = await readResponse(response);
            if (!ok || !data?.refund_id) {
                return { success: false, message: error?.message || 'DodoPayments 退款失败' };
            }
            return {
                success: true,
                refundNo,
                thirdPartyRefundNo: String(data.refund_id)
            };
        } catch (error: any) {
            return { success: false, message: error?.message || 'DodoPayments 退款失败' };
        }
    }

    /** 查询退款状态：GET /refunds/{refund_id} */
    async queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus> {
        try {
            const cfg = config as DodoConfig;
            if (!/^ref_/.test(refundNo)) {
                return { status: 'processing', message: '非 DodoPayments 退款单号' };
            }
            const response = await this.request(cfg, `/refunds/${encodeURIComponent(refundNo)}`, { method: 'GET' });
            const { ok, data } = await readResponse(response);
            if (!ok || !data) return { status: 'processing' };
            return {
                status: mapRefundStatus(String(data.status || '')),
                amount: fromMinorUnits(data.amount),
                refundedAt: data.created_at,
                message: data.status === 'failed' ? '渠道退款失败' : undefined
            };
        } catch {
            return { status: 'processing' };
        }
    }
}
