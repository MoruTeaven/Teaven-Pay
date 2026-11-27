/**
 * Stripe 风格兼容层（服务端直连最小子集）
 *
 * 让原本对接 Stripe / Hyperswitch（其自带 Stripe 兼容层）的服务端客户端
 * 把 base URL 切到 Teaven Pay 即可工作，无需改动业务代码。
 *
 * 设计原则：
 *   1. 独立前缀 /v1/*，不动现有 /api/pay/* 与通用易支付入口；
 *   2. 只做协议适配：认证 + 字段映射 + 响应重塑，业务逻辑一律内部转发给
 *      payRouter，完整复用签名验签、SSRF 校验、幂等、入账等主流程；
 *   3. 能力表达不了的（client_secret / 3DS / Vault / 多 PSP 路由）明确报错，
 *      不伪装支持。
 *
 * 端点：
 *   POST   /v1/payment_intents          创建并下单
 *   GET    /v1/payment_intents/:id      查单
 *   GET    /v1/payment_intents          订单列表
 *   POST   /v1/payment_intents/:id/cancel  关单
 *   POST   /v1/refunds                  退款
 *   GET    /v1/refunds/:id              查退款
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { payRouter } from './pay';
import { generateUUIDv7 } from '../utils/uuid';
import { generateSignAsync } from '../utils/crypto';
import { timingSafeEqual } from '../utils/constantTime';
import {
    minorUnitsToYuan,
    isSupportedCurrency,
    buildPaymentIntent,
    buildRefund,
    buildList,
    stripeError,
    stripeErrors,
    StripeError,
} from '../utils/stripe-compat';

export const stripeRouter = new Hono<{ Bindings: Env }>();

/** 认证结果：商户 ID + 命中的明文密钥 */
interface StripeAuth {
    pid: string;
    apiKey: string;
    apiKeyType: string;
}

/**
 * 从 Bearer / X-API-Key 中提取候选密钥。
 *
 * 兼容 Stripe 习惯的 sk_ / sk_test_ / sk_live_ 前缀：剥离后即为我们的 api_key，
 * 商户无需更换已有密钥。也接受裸 api_key（方便服务端直连调试）。
 */
function extractSecret(headers: Headers): string | null {
    const authorization = headers.get('Authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    let secret = bearer ? bearer[1].trim() : (headers.get('X-API-Key') || '').trim();
    if (!secret) return null;

    const stripped = /^sk_(?:test_|live_)?(.+)$/i.exec(secret);
    if (stripped && stripped[1]) secret = stripped[1].trim();
    return secret || null;
}

/**
 * Stripe 风格认证：密钥即身份（客户端不带 pid）。
 *
 * 全库扫描启用中的 api_keys，常数时间匹配，返回所属商户。
 * 只查 status=1 的记录；不做命中即返回，避免时序侧信道。
 */
async function authenticate(env: Env, headers: Headers): Promise<StripeAuth | null> {
    const secret = extractSecret(headers);
    if (!secret) return null;

    const result = await env.DB.prepare(
        'SELECT user_id, api_key, api_key_type FROM api_keys WHERE status = 1'
    ).all();

    let matched: StripeAuth | null = null;
    for (const row of (result.results || []) as Array<{ user_id: string; api_key: string; api_key_type: string | null }>) {
        if (typeof row?.api_key === 'string' && timingSafeEqual(row.api_key, secret)) {
            matched = { pid: row.user_id, apiKey: row.api_key, apiKeyType: row.api_key_type || 'hmac-sha256' };
        }
    }
    return matched;
}

/** 内部转发：构造一个内部 Request 交给 payRouter，复用主流程全部安全约束 */
async function callPayRouter(
    c: any,
    path: string,
    options: { method?: 'GET' | 'POST'; form?: Record<string, string>; query?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
    const method = options.method || 'GET';
    const url = new URL(`https://teaven.internal${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
        url.searchParams.set(key, value);
    }

    const headers = new Headers();
    let body: string | undefined;
    if (method === 'POST') {
        const params = new URLSearchParams(options.form || {});
        body = params.toString();
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }

    const req = new Request(url.toString(), { method, headers, body });
    const res = await payRouter.fetch(req, c.env);
    let parsed: any = null;
    try {
        parsed = await res.json();
    } catch {
        parsed = null;
    }
    return { status: res.status, body: parsed };
}

/** 内部响应 code → Stripe 错误 */
function internalError(body: any, status: number): StripeError {
    const msg = typeof body?.msg === 'string' ? body.msg : '请求失败';
    switch (body?.code) {
        case -2:
        case -3:
            return stripeErrors.unauthenticated(msg);
        case -4:
            return stripeErrors.notFound(msg);
        case -1:
            return stripeErrors.invalidRequest(msg);
        case -5:
            return stripeErrors.server(msg);
        default:
            return status >= 500 ? stripeErrors.server(msg) : stripeErrors.invalidRequest(msg);
    }
}

/** 统一的认证失败响应 */
function unauthenticated(c: any) {
    const err = stripeErrors.unauthenticated();
    return c.json(err, err.error.status_code);
}

/**
 * 解析下单参数（Stripe → 内部）
 *
 * out_trade_no 优先取 Idempotency-Key / metadata.out_trade_no，保证幂等；
 * 都没有才生成 UUIDv7（此时不幂等，但 Stripe 客户端一般会带 Idempotency-Key）。
 */
function resolveCreateParams(body: any, auth: StripeAuth): {
    type: string;
    outTradeNo: string;
    money: string;
    name: string;
    notifyUrl?: string;
    returnUrl?: string;
} | StripeError {
    const currency = body?.currency ?? 'cny';
    if (!isSupportedCurrency(currency)) {
        return stripeErrors.invalidRequest(`不支持的币种：${String(currency)}，当前仅支持 CNY`, 'currency');
    }

    const amount = body?.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
        return stripeErrors.invalidRequest('amount 必须为正整数（最小货币单位：分）', 'amount');
    }
    let money: string;
    try {
        money = minorUnitsToYuan(amount);
    } catch {
        return stripeErrors.invalidRequest('amount 不合法', 'amount');
    }

    const metadata = (body?.metadata && typeof body.metadata === 'object') ? body.metadata : {};
    const idempotencyKey = typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
    const rawOutTradeNo = metadata.out_trade_no || idempotencyKey || body?.id;
    // Stripe 订单号格式与内部一致（字母数字点下划线横线竖线），非法字符直接拒绝
    const outTradeNo = typeof rawOutTradeNo === 'string' && /^[a-zA-Z0-9._\-|]+$/.test(rawOutTradeNo)
        ? rawOutTradeNo
        : generateUUIDv7();

    const type = typeof metadata.type === 'string' && metadata.type.trim()
        ? metadata.type.trim()
        : 'alipay';

    const name = typeof body?.description === 'string' && body.description.trim()
        ? body.description.trim()
        : 'Stripe 兼容层订单';

    return {
        type,
        outTradeNo,
        money,
        name,
        notifyUrl: typeof metadata.notify_url === 'string' ? metadata.notify_url : undefined,
        returnUrl: typeof metadata.return_url === 'string' ? metadata.return_url : undefined,
    };
}

/** 读取商户默认通知/回跳地址，供 Stripe 客户端（不带 notify_url）兜底 */
async function resolveUrls(env: Env, pid: string, origin: string, overrides: { notifyUrl?: string; returnUrl?: string }): Promise<{ notifyUrl: string; returnUrl: string }> {
    const user = await env.DB.prepare(
        'SELECT notify_url, return_url FROM users WHERE id = ?'
    ).bind(pid).first<{ notify_url: string | null; return_url: string | null }>();

    const notifyUrl = overrides.notifyUrl || user?.notify_url || `${origin}/notify/alipay`;
    const returnUrl = overrides.returnUrl || user?.return_url || `${origin}/result/placeholder`;
    return { notifyUrl, returnUrl };
}

/* ------------------------------------------------------------------ */
/* POST /v1/payment_intents                                              */
/* ------------------------------------------------------------------ */
stripeRouter.post('/payment_intents', async (c: any) => {
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (!auth) return unauthenticated(c);

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        const err = stripeErrors.invalidRequest('请求体必须是合法 JSON');
        return c.json(err, err.error.status_code);
    }

    const params = resolveCreateParams(body, auth);
    if ('error' in params) {
        return c.json(params, params.error.status_code);
    }

    try {
        const origin = new URL(c.req.url).origin;
        const urls = await resolveUrls(c.env, auth.pid, origin, params);

        // 用商户密钥生成内部 submit 签名。待签串口径必须与 authorizeSignedRequest
        // 完全一致：它会自动加入 pid，并剔除空值；因此这里也要带 pid，且空值不传。
        // 签名类型取商户密钥记录的实际类型，兼容存量 md5 商户。
        const signParams: Record<string, string> = {
            pid: auth.pid,
            type: params.type,
            out_trade_no: params.outTradeNo,
            notify_url: urls.notifyUrl,
            name: params.name,
            money: params.money,
        };
        const sign = await generateSignAsync(signParams, auth.apiKey, auth.apiKeyType);

        const internal = await callPayRouter(c, '/api/pay/submit', {
            method: 'POST',
            form: {
                pid: auth.pid,
                type: params.type,
                out_trade_no: params.outTradeNo,
                notify_url: urls.notifyUrl,
                return_url: urls.returnUrl,
                name: params.name,
                money: params.money,
                sign,
                sign_type: 'HMAC-SHA256',
                clientip: '127.0.0.1',
            },
        });

        if (internal.body?.code !== 1) {
            const err = internalError(internal.body, internal.status);
            return c.json(err, err.error.status_code);
        }

        // 读取订单拿到 created_at，组装 Stripe PaymentIntent
        const order = await c.env.DB.prepare(
            'SELECT id, amount, status, created_at, name, out_trade_no FROM orders WHERE id = ? AND user_id = ?'
        ).bind(internal.body.trade_no, auth.pid).first() as any;

        const intent = buildPaymentIntent({
            id: internal.body.trade_no,
            amount: order?.amount ?? params.money,
            status: order?.status ?? 0,
            createdAt: order?.created_at ?? new Date().toISOString(),
            description: params.name,
            outTradeNo: params.outTradeNo,
            livemode: c.env.ENVIRONMENT === 'production',
            delivery: internal.body.qrcode
                ? { type: 'qrcode', qrcode: internal.body.qrcode, qrcodeUrl: internal.body.qrcodeUrl, payUrl: internal.body.payurl }
                : internal.body.payurl
                    ? { type: 'link', payUrl: internal.body.payurl }
                    : null,
        });

        return c.json(intent, 200);
    } catch (error) {
        console.error('[Stripe/payment_intents create] error:', error);
        const err = stripeErrors.server();
        return c.json(err, err.error.status_code);
    }
});

/* ------------------------------------------------------------------ */
/* GET /v1/payment_intents/:id                                          */
/* ------------------------------------------------------------------ */
stripeRouter.get('/payment_intents/:id', async (c: any) => {
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (!auth) return unauthenticated(c);

    const id = c.req.param('id');
    try {
        // 内部 query 支持请求头明文密钥认证，直接带 X-API-Key 转发
        const internal = await callPayRouterWithKey(c, '/api/pay/query', auth.apiKey, { pid: auth.pid, trade_no: id });
        if (internal.body?.code !== 1) {
            const err = internalError(internal.body, internal.status);
            return c.json(err, err.error.status_code);
        }
        return c.json(intentFromQuery(internal.body), 200);
    } catch (error) {
        console.error('[Stripe/payment_intents retrieve] error:', error);
        const err = stripeErrors.server();
        return c.json(err, err.error.status_code);
    }
});

/** 带 X-API-Key 的内部转发（供需要明文密钥认证的内部端点复用） */
async function callPayRouterWithKey(
    c: any,
    path: string,
    apiKey: string,
    query: Record<string, string>,
    form?: Record<string, string>
): Promise<{ status: number; body: any }> {
    const method = form ? 'POST' : 'GET';
    const url = new URL(`https://teaven.internal${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const headers = new Headers({ 'X-API-Key': apiKey });
    let body: string | undefined;
    if (form) {
        body = new URLSearchParams(form).toString();
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }

    const res = await payRouter.fetch(new Request(url.toString(), { method, headers, body }), c.env);
    let parsed: any = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
}

/** 内部 query 响应 → Stripe PaymentIntent */
function intentFromQuery(q: any) {
    return buildPaymentIntent({
        id: q.trade_no,
        amount: q.money,
        status: Number(q.status),
        createdAt: q.addtime,
        description: q.name,
        outTradeNo: q.out_trade_no,
    });
}

/* ------------------------------------------------------------------ */
/* GET /v1/payment_intents                                              */
/* ------------------------------------------------------------------ */
stripeRouter.get('/payment_intents', async (c: any) => {
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (!auth) return unauthenticated(c);

    const rawLimit = Number(c.req.query('limit') || '10');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 50) : 10;
    const startingAfter = c.req.query('starting_after');
    // Stripe 游标分页 → 内部 offset（简化：直接用数字游标；非数字从 0 开始）
    const offset = startingAfter && /^\d+$/.test(startingAfter) ? Number(startingAfter) : 0;

    try {
        const internal = await callPayRouterWithKey(c, '/api/pay/orders', auth.apiKey, {
            pid: auth.pid,
            limit: String(limit),
            offset: String(offset),
        });
        if (internal.body?.code !== 1) {
            const err = internalError(internal.body, internal.status);
            return c.json(err, err.error.status_code);
        }

        const data = (internal.body.data || []).map((row: any) => intentFromQuery(row));
        const count = Number(internal.body.count || 0);
        return c.json(buildList('payment_intents', data, offset + data.length < count), 200);
    } catch (error) {
        console.error('[Stripe/payment_intents list] error:', error);
        const err = stripeErrors.server();
        return c.json(err, err.error.status_code);
    }
});

/* ------------------------------------------------------------------ */
/* POST /v1/payment_intents/:id/cancel                                  */
/* ------------------------------------------------------------------ */
stripeRouter.post('/payment_intents/:id/cancel', async (c: any) => {
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (!auth) return unauthenticated(c);

    const id = c.req.param('id');
    try {
        const internal = await callPayRouterWithKey(c, '/api/pay/close', auth.apiKey, {}, {
            pid: auth.pid,
            trade_no: id,
        });
        if (internal.body?.code !== 1) {
            const err = internalError(internal.body, internal.status);
            return c.json(err, err.error.status_code);
        }

        // 关闭后回读订单，返回 canceled 状态的 PaymentIntent
        const order = await c.env.DB.prepare(
            'SELECT id, amount, status, created_at, name, out_trade_no FROM orders WHERE id = ? AND user_id = ?'
        ).bind(id, auth.pid).first() as any;

        return c.json(buildPaymentIntent({
            id,
            amount: order?.amount ?? 0,
            status: 3,
            createdAt: order?.created_at ?? new Date().toISOString(),
            description: order?.name,
            outTradeNo: order?.out_trade_no,
            livemode: c.env.ENVIRONMENT === 'production',
        }), 200);
    } catch (error) {
        console.error('[Stripe/payment_intents cancel] error:', error);
        const err = stripeErrors.server();
        return c.json(err, err.error.status_code);
    }
});

/* ------------------------------------------------------------------ */
/* POST /v1/refunds                                                     */
/* ------------------------------------------------------------------ */
stripeRouter.post('/refunds', async (c: any) => {
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (!auth) return unauthenticated(c);

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        const err = stripeErrors.invalidRequest('请求体必须是合法 JSON');
        return c.json(err, err.error.status_code);
    }

    const currency = body?.currency ?? 'cny';
    if (!isSupportedCurrency(currency)) {
        const err = stripeErrors.invalidRequest(`不支持的币种：${String(currency)}`, 'currency');
        return c.json(err, err.error.status_code);
    }
    const paymentIntent = typeof body?.payment_intent === 'string' ? body.payment_intent.trim() : '';
    if (!paymentIntent) {
        const err = stripeErrors.invalidRequest('payment_intent 不能为空', 'payment_intent');
        return c.json(err, err.error.status_code);
    }
    if (!Number.isInteger(body?.amount) || body.amount <= 0) {
        const err = stripeErrors.invalidRequest('amount 必须为正整数（最小货币单位：分）', 'amount');
        return c.json(err, err.error.status_code);
    }

    try {
        const money = minorUnitsToYuan(body.amount);
        const reason = typeof body?.reason === 'string' ? body.reason : '';
        const internal = await callPayRouterWithKey(c, '/api/pay/refund', auth.apiKey, {}, {
            pid: auth.pid,
            trade_no: paymentIntent,
            money,
            reason,
        });
        if (internal.body?.code !== 1) {
            const err = internalError(internal.body, internal.status);
            return c.json(err, err.error.status_code);
        }

        return c.json(buildRefund({
            id: internal.body.refund_no,
            amount: internal.body.money ?? money,
            status: Number(internal.body.status),
            createdAt: new Date().toISOString(),
            paymentIntentId: paymentIntent,
            reason: reason || null,
        }), 200);
    } catch (error) {
        console.error('[Stripe/refunds create] error:', error);
        const err = stripeErrors.server();
        return c.json(err, err.error.status_code);
    }
});

/* ------------------------------------------------------------------ */
/* GET /v1/refunds/:id                                                  */
/* ------------------------------------------------------------------ */
stripeRouter.get('/refunds/:id', async (c: any) => {
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (!auth) return unauthenticated(c);

    const id = c.req.param('id');
    try {
        const internal = await callPayRouterWithKey(c, '/api/pay/refund/query', auth.apiKey, {
            pid: auth.pid,
            refund_no: id,
        });
        if (internal.body?.code !== 1) {
            const err = internalError(internal.body, internal.status);
            return c.json(err, err.error.status_code);
        }
        return c.json(buildRefund({
            id: internal.body.refund_no,
            amount: internal.body.money,
            status: Number(internal.body.status),
            createdAt: internal.body.addtime,
            paymentIntentId: internal.body.trade_no,
        }), 200);
    } catch (error) {
        console.error('[Stripe/refunds retrieve] error:', error);
        const err = stripeErrors.server();
        return c.json(err, err.error.status_code);
    }
});

/* ------------------------------------------------------------------ */
/* 明确不支持的能力：给出清晰错误，不伪装                                */
/* ------------------------------------------------------------------ */
stripeRouter.all('/payment_intents/:id/confirm', (c: any) => {
    const err = stripeErrors.unsupported('PaymentIntent confirm（请直接创建已确认的支付）');
    return c.json(err, err.error.status_code);
});
stripeRouter.all('/payment_intents/:id/capture', (c: any) => {
    const err = stripeErrors.unsupported('手动 capture（请设置自动请款）');
    return c.json(err, err.error.status_code);
});
stripeRouter.all('/customers/*', (c: any) => {
    const err = stripeErrors.unsupported('Customers（客户档案）');
    return c.json(err, err.error.status_code);
});
