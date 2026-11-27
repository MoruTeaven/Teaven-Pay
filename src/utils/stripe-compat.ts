/**
 * Stripe 风格兼容层 - 纯函数工具
 *
 * 负责 Stripe 协议与 Teaven Pay 内部协议之间的无副作用转换：
 *   - 金额：Stripe 最小货币单位（分） ↔ 元
 *   - 状态：orders.status(0/1/2/3)、refunds.status(0/1/2) ↔ Stripe status
 *   - 对象：内部行/内部响应 → Stripe PaymentIntent / Refund 对象
 *   - 错误：Stripe 风格 error 对象 + HTTP 状态码
 *
 * 这里刻意不依赖任何 D1 / fetch，便于独立契约测试。
 */

/** 兼容层当前只支持人民币 */
export const STRIPE_SUPPORTED_CURRENCY = 'cny';

/** Stripe 错误类型（对应 Stripe error.type） */
export type StripeErrorType =
    | 'invalid_request_error'
    | 'authentication_error'
    | 'permission_error'
    | 'idempotency_error'
    | 'card_error'
    | 'api_error';

export interface StripeError {
    error: {
        type: StripeErrorType;
        code?: string;
        message: string;
        param?: string;
        status_code: number;
    };
}

/**
 * 分 → 元（字符串，保留两位小数）
 *
 * Stripe 的 amount 是整数最小货币单位；内部 money 是十进制元字符串。
 * 用整数运算避免浮点误差：777n → "7.77"。
 */
export function minorUnitsToYuan(minor: number): string {
    if (!Number.isInteger(minor) || minor <= 0) {
        throw new RangeError('amount 必须为正整数（最小货币单位）');
    }
    const yuan = Math.floor(minor / 100);
    const cents = minor % 100;
    return `${yuan}.${String(cents).padStart(2, '0')}`;
}

/**
 * 元 → 分（整数）
 *
 * 用于把内部订单金额转成 Stripe 响应里的 amount。
 * 用字符串解析 + 四舍五入到分，避免 REAL 浮点尾差。
 */
export function yuanToMinorUnits(yuan: number | string): number {
    const value = typeof yuan === 'number' ? yuan.toFixed(2) : String(yuan);
    const [whole, fraction = ''] = value.split('.');
    const cents = Number(fraction.padEnd(2, '0').slice(0, 2));
    return Number(whole) * 100 + cents;
}

/** 校验 currency：仅接受 cny（大小写不敏感），其它显式拒绝 */
export function isSupportedCurrency(currency: unknown): boolean {
    return typeof currency === 'string' && currency.trim().toLowerCase() === STRIPE_SUPPORTED_CURRENCY;
}

/**
 * 内部订单状态 → Stripe PaymentIntent status
 *
 * 内部状态：0 未支付 / 1 已支付 / 2 已退款 / 3 已关闭
 * Stripe 状态：requires_payment_method / requires_confirmation / requires_action /
 *             processing / requires_capture / canceled / succeeded
 *
 * 我们没有两阶段确认与请款模型：
 *   - 未支付 → requires_payment_method（等待买家付款）
 *   - 已支付 → succeeded
 *   - 已退款 → succeeded（Stripe 退款不改变 PaymentIntent 状态，用 refunds 表达）
 *   - 已关闭 → canceled
 */
export function mapOrderStatusToStripe(status: number): string {
    switch (status) {
        case 0: return 'requires_payment_method';
        case 1: return 'succeeded';
        case 2: return 'succeeded';
        case 3: return 'canceled';
        default: return 'requires_payment_method';
    }
}

/** 内部退款状态 → Stripe Refund status */
export function mapRefundStatusToStripe(status: number): string {
    switch (status) {
        case 1: return 'succeeded';
        case 2: return 'failed';
        default: return 'pending';
    }
}

export interface PaymentIntentLike {
    id: string;
    object: 'payment_intent';
    amount: number;
    amount_received: number;
    currency: string;
    status: string;
    created: number;
    description: string | null;
    metadata: Record<string, string>;
    client_secret: string | null;
    payment_method_types: string[];
    livemode: boolean;
    // 兼容层扩展字段：来自 Teaven Pay 的收银台交付信息
    next_action?: Record<string, unknown> | null;
}

/** Unix 秒时间戳（Stripe created 用秒，非毫秒） */
export function toUnixSeconds(value: string | number | Date): number {
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

/**
 * 构造 Stripe PaymentIntent 对象
 *
 * 复用现有订单行字段：id、amount、status、created_at、name、out_trade_no。
 * 不支持 client_secret（我们无浏览器 SDK 流程），显式置 null。
 */
export function buildPaymentIntent(input: {
    id: string;
    amount: number | string;
    status: number;
    createdAt: string | number | Date;
    description?: string | null;
    outTradeNo?: string | null;
    currency?: string;
    livemode?: boolean;
    delivery?: {
        type: 'qrcode' | 'link' | 'form' | 'jsapi';
        payUrl?: string;
        qrcode?: string;
        qrcodeUrl?: string;
    } | null;
}): PaymentIntentLike {
    const amount = yuanToMinorUnits(input.amount);
    const status = mapOrderStatusToStripe(input.status);
    const intent: PaymentIntentLike = {
        id: input.id,
        object: 'payment_intent',
        amount,
        amount_received: status === 'succeeded' ? amount : 0,
        currency: (input.currency || STRIPE_SUPPORTED_CURRENCY).toLowerCase(),
        status,
        created: toUnixSeconds(input.createdAt),
        description: input.description ?? null,
        metadata: input.outTradeNo ? { out_trade_no: input.outTradeNo } : {},
        // 无 client_secret：我们不支持浏览器 SDK 的确认流程
        client_secret: null,
        payment_method_types: ['alipay', 'wechat'],
        livemode: input.livemode ?? false,
    };

    // 未支付时把收银台/二维码信息放进 next_action，供服务端直连客户渲染
    if (input.delivery && status === 'requires_payment_method') {
        const { type, payUrl, qrcode, qrcodeUrl } = input.delivery;
        intent.next_action = {
            type: 'teaven_pay_display',
            display_type: type,
            ...(payUrl ? { url: payUrl } : {}),
            ...(qrcode ? { qrcode } : {}),
            ...(qrcodeUrl ? { qrcode_url: qrcodeUrl } : {}),
        };
    }

    return intent;
}

export interface RefundLike {
    id: string;
    object: 'refund';
    amount: number;
    currency: string;
    status: string;
    created: number;
    payment_intent: string;
    reason: string | null;
    metadata: Record<string, string>;
}

/** 构造 Stripe Refund 对象 */
export function buildRefund(input: {
    id: string;
    amount: number | string;
    currency?: string;
    status: number;
    createdAt: string | number | Date;
    paymentIntentId: string;
    reason?: string | null;
}): RefundLike {
    return {
        id: input.id,
        object: 'refund',
        amount: yuanToMinorUnits(input.amount),
        currency: (input.currency || STRIPE_SUPPORTED_CURRENCY).toLowerCase(),
        status: mapRefundStatusToStripe(input.status),
        created: toUnixSeconds(input.createdAt),
        payment_intent: input.paymentIntentId,
        reason: input.reason ?? null,
        metadata: {},
    };
}

/** Stripe 列表响应外壳 */
export function buildList<T>(object: string, data: T[], hasMore: boolean): {
    object: 'list';
    data: T[];
    has_more: boolean;
    url: string;
} {
    return { object: 'list', data, has_more: hasMore, url: `/v1/${object}` };
}

/**
 * 构造 Stripe 风格错误响应
 *
 * status_code 必须是合法的 HTTP 状态（400/401/402/403/404/409/429/500）。
 */
export function stripeError(
    type: StripeErrorType,
    message: string,
    statusCode: number,
    options: { code?: string; param?: string } = {}
): StripeError {
    const allowed = [400, 401, 402, 403, 404, 409, 429, 500];
    const status_code = allowed.includes(statusCode) ? statusCode : 400;
    return {
        error: {
            type,
            code: options.code,
            message,
            param: options.param,
            status_code,
        },
    };
}

/** 常见错误快捷构造 */
export const stripeErrors = {
    unauthenticated: (message = '未提供有效的 API 密钥') =>
        stripeError('authentication_error', message, 401, { code: 'api_key_invalid' }),
    invalidRequest: (message: string, param?: string) =>
        stripeError('invalid_request_error', message, 400, { param }),
    notFound: (message: string) =>
        stripeError('invalid_request_error', message, 404, { code: 'resource_missing' }),
    unsupported: (feature: string) =>
        stripeError('invalid_request_error', `Teaven Pay 暂不支持 ${feature}`, 400, { code: 'unsupported_feature' }),
    server: (message = '服务器内部错误') =>
        stripeError('api_error', message, 500),
};
