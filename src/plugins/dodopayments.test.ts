/**
 * DodoPayments 插件回归测试
 *
 * 覆盖：
 *  1) 下单请求形状：金额转最小单位、metadata 带平台订单号、返回 checkout_url/session_id
 *  2) Webhook 验签：Standard Webhooks 签名正确才入账，篡改 body 拒绝
 *  3) 回调回传 paidAmount（实付金额，分转元）
 *  4) 查单：payment_id 直查 / checkout session 二次查询
 *  5) 退款：全额退款调用 POST /refunds，部分退款拒绝
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DodoPaymentsPlugin } from './dodopayments';
import { DODO_PAYMENT_METHODS, DODO_PAYMENT_TYPE_NAMES, normalizeDodoMethodTypes } from './dodopayments-methods';

const ORDER: any = {
    tradeNo: '0199f1a7-7777-7000-8000-000000000777',
    outTradeNo: 'OUT777777',
    amount: 7.77,
    actualAmount: 7.77,
    subject: '测试商品',
    clientIp: '127.0.0.1',
    createdAt: new Date().toISOString(),
};

const CONFIG: any = {
    appId: 'pdt_123abc456def',
    appSecret: 'dodo_test_secret',
    apiKey: 'dodo_test_secret',
    productId: 'pdt_123abc456def',
    webhookSecret: 'whsec_dGVzdF9zZWNyZXRfa2V5',
    currency: 'USD',
};

interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
}

function stubFetch(handler: (call: FetchCall) => any) {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
        const call: FetchCall = {
            url: String(url),
            method: String(init?.method || 'GET'),
            headers: { ...(init?.headers || {}) },
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        const response = handler(call);
        return {
            ok: response.__status ? response.__status < 400 : true,
            status: response.__status || 200,
            text: async () => JSON.stringify(response),
        };
    }));
    return calls;
}

/** 生成 Standard Webhooks 签名 */
async function signWebhook(raw: string, id: string, timestamp: string, secret: string): Promise<string> {
    const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return `v1,${b64}`;
}

beforeEach(() => {
    vi.useRealTimers();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('DodoPayments 支付方式清单', () => {
    it('官方 29 种支付方式，code 唯一且与插件 supportedTypes 一致', () => {
        expect(DODO_PAYMENT_METHODS.length).toBe(29);
        const codes = DODO_PAYMENT_METHODS.map((m) => m.code);
        expect(new Set(codes).size).toBe(29);
        expect(DODO_PAYMENT_TYPE_NAMES).toEqual(codes);
        expect(new DodoPaymentsPlugin().supportedTypes).toEqual(codes);
    });

    it('白名单归一化：兼容数组 / 逗号分隔，过滤非法 code', () => {
        expect(normalizeDodoMethodTypes(['credit', 'apple_pay'])).toEqual(['credit', 'apple_pay']);
        expect(normalizeDodoMethodTypes('we_chat_pay,gcash')).toEqual(['we_chat_pay', 'gcash']);
        expect(normalizeDodoMethodTypes(['credit', 'unknown', 'CREDIT'])).toEqual(['credit']);
        expect(normalizeDodoMethodTypes(undefined)).toEqual([]);
    });
});

describe('DodoPaymentsPlugin 下单', () => {
    it('金额转最小单位并携带平台订单号，返回 checkout_url', async () => {
        const calls = stubFetch(() => ({
            session_id: 'cks_Gi6KGJ2zFJo9rq9Ukifwa',
            checkout_url: 'https://test.checkout.dodopayments.com/session/cks_Gi6KGJ2zFJo9rq9Ukifwa',
        }));

        const result = await new DodoPaymentsPlugin().createPayment(ORDER, {
            ...CONFIG,
            returnUrl: 'https://pay.example.com/result/T777',
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe('jump');
        expect(result.payUrl).toContain('checkout.dodopayments.com');
        // 下单拿不到最终 payment_id，先回传 session id 供路由落库
        expect(result.externalTradeNo).toBe('cks_Gi6KGJ2zFJo9rq9Ukifwa');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://test.dodopayments.com/checkouts');
        expect(calls[0].method).toBe('POST');
        expect(calls[0].headers.Authorization).toBe('Bearer dodo_test_secret');
        expect(calls[0].body.product_cart[0]).toMatchObject({
            product_id: 'pdt_123abc456def',
            quantity: 1,
            amount: 777,
        });
        expect(calls[0].body.metadata.trade_no).toBe(ORDER.tradeNo);
        expect(calls[0].body.return_url).toBe('https://pay.example.com/result/T777');
        // 默认 USD 不重复下发 billing_currency
        expect(calls[0].body.billing_currency).toBeUndefined();
    });

    it('按 payment_method_type 限定收银台支付方式，默认不带卡兜底', async () => {
        const calls = stubFetch(() => ({
            session_id: 'cks_method',
            checkout_url: 'https://test.checkout.dodopayments.com/session/cks_method',
        }));
        await new DodoPaymentsPlugin().createPayment(ORDER, {
            ...CONFIG,
            payment_method_type: 'we_chat_pay',
        });
        expect(calls[0].body.allowed_payment_method_types).toEqual(['we_chat_pay']);
    });

    it('开启 allowCardFallback 时附带信用卡/借记卡兜底', async () => {
        const calls = stubFetch(() => ({
            session_id: 'cks_fallback',
            checkout_url: 'https://test.checkout.dodopayments.com/session/cks_fallback',
        }));
        await new DodoPaymentsPlugin().createPayment(ORDER, {
            ...CONFIG,
            payment_method_type: ['ideal'],
            allowCardFallback: true,
        });
        expect(calls[0].body.allowed_payment_method_types).toEqual(['ideal', 'credit', 'debit']);
    });

    it('live key 自动切到 live 域名', async () => {
        const calls = stubFetch(() => ({
            session_id: 'cks_live',
            checkout_url: 'https://checkout.dodopayments.com/session/cks_live',
        }));
        await new DodoPaymentsPlugin().createPayment(ORDER, {
            ...CONFIG,
            apiKey: 'dodo_live_secret',
            appSecret: 'dodo_live_secret',
        });
        expect(calls[0].url).toBe('https://live.dodopayments.com/checkouts');
    });

    it('配置不完整时直接失败，不发请求', async () => {
        const calls = stubFetch(() => ({}));
        const result = await new DodoPaymentsPlugin().createPayment(ORDER, { appId: '', appSecret: '' });
        expect(result.success).toBe(false);
        expect(calls).toHaveLength(0);
    });
});

describe('DodoPaymentsPlugin Webhook 验签', () => {
    function buildEvent(type: string, extra: Record<string, any> = {}) {
        return {
            business_id: 'bus_test',
            type,
            timestamp: new Date().toISOString(),
            data: {
                payload_type: 'Payment',
                payment_id: 'pay_gr4RizvMOXFJ6xca3y2tU',
                total_amount: 777,
                currency: 'USD',
                metadata: { trade_no: ORDER.tradeNo, out_trade_no: ORDER.outTradeNo },
                customer: { email: 'buyer@example.com' },
                created_at: '2026-11-27T10:00:00Z',
                ...extra,
            },
        };
    }

    it('payment.succeeded 验签通过，回传实付金额与平台订单号', async () => {
        const raw = JSON.stringify(buildEvent('payment.succeeded'));
        const id = 'wh_777';
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signWebhook(raw, id, timestamp, CONFIG.webhookSecret);

        const result = await new DodoPaymentsPlugin().verifyNotify({
            __raw: raw,
            __headers: {
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': signature,
            },
        }, CONFIG);

        expect(result.success).toBe(true);
        expect(result.status).toBe('success');
        expect(result.tradeNo).toBe(ORDER.tradeNo);
        expect(result.thirdPartyTradeNo).toBe('pay_gr4RizvMOXFJ6xca3y2tU');
        expect(result.paidAmount).toBe(7.77);
    });

    it('body 被篡改时验签失败，不返回订单号', async () => {
        const raw = JSON.stringify(buildEvent('payment.succeeded'));
        const id = 'wh_777';
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signWebhook(raw, id, timestamp, CONFIG.webhookSecret);

        // 模拟中间人把金额改成 0.01
        const tampered = raw.replace('"total_amount":777', '"total_amount":1');
        const result = await new DodoPaymentsPlugin().verifyNotify({
            __raw: tampered,
            __headers: {
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': signature,
            },
        }, CONFIG);

        expect(result.success).toBe(false);
        expect(result.tradeNo).toBe('');
        expect(result.errorCode).toBe('VERIFY_FAILED');
    });

    it('过期时间戳拒绝（防重放）', async () => {
        const raw = JSON.stringify(buildEvent('payment.succeeded'));
        const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
        const signature = await signWebhook(raw, 'wh_old', oldTs, CONFIG.webhookSecret);
        const result = await new DodoPaymentsPlugin().verifyNotify({
            __raw: raw,
            __headers: {
                'webhook-id': 'wh_old',
                'webhook-timestamp': oldTs,
                'webhook-signature': signature,
            },
        }, CONFIG);
        expect(result.success).toBe(false);
    });

    it('metadata 未传播时按 hint 定位订单', async () => {
        const event = buildEvent('payment.succeeded');
        delete (event.data as any).metadata;
        (event.data as any).checkout_session_id = 'cks_777';
        const raw = JSON.stringify(event);
        const id = 'wh_hint';
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signWebhook(raw, id, timestamp, CONFIG.webhookSecret);

        const result = await new DodoPaymentsPlugin().verifyNotify({
            __raw: raw,
            __headers: {
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': signature,
            },
        }, { ...CONFIG, __tradeNoHint: ORDER.tradeNo, __outTradeNoHint: ORDER.outTradeNo });

        expect(result.success).toBe(true);
        expect(result.tradeNo).toBe(ORDER.tradeNo);
        expect(result.outTradeNo).toBe(ORDER.outTradeNo);
    });

    it('非支付事件不驱动入账', async () => {
        const raw = JSON.stringify(buildEvent('subscription.active'));
        const id = 'wh_sub';
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signWebhook(raw, id, timestamp, CONFIG.webhookSecret);
        const result = await new DodoPaymentsPlugin().verifyNotify({
            __raw: raw,
            __headers: {
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': signature,
            },
        }, CONFIG);
        expect(result.success).toBe(true);
        expect(result.status).toBe('pending');
        expect(result.tradeNo).toBe('');
    });
});

describe('DodoPaymentsPlugin 查单与退款', () => {
    it('按 payment_id 查单，回传 paidAmount', async () => {
        const calls = stubFetch(() => ({
            payment_id: 'pay_gr4RizvMOXFJ6xca3y2tU',
            status: 'succeeded',
            total_amount: 777,
            currency: 'USD',
            customer: { email: 'buyer@example.com' },
            created_at: '2026-11-27T10:00:00Z',
        }));
        const status = await new DodoPaymentsPlugin().queryOrder(ORDER.tradeNo, {
            ...CONFIG,
            externalTradeNo: 'pay_gr4RizvMOXFJ6xca3y2tU',
        });
        expect(status.status).toBe('paid');
        expect(status.paidAmount).toBe(7.77);
        expect(status.thirdPartyTradeNo).toBe('pay_gr4RizvMOXFJ6xca3y2tU');
        expect(calls[0].url).toContain('/payments/pay_gr4RizvMOXFJ6xca3y2tU');
    });

    it('按 checkout session 查单：payment_id 为空则不入账', async () => {
        stubFetch(() => ({
            id: 'cks_1',
            payment_id: null,
            payment_status: null,
        }));
        const status = await new DodoPaymentsPlugin().queryOrder(ORDER.tradeNo, {
            ...CONFIG,
            externalTradeNo: 'cks_1',
        });
        expect(status.status).toBe('pending');
    });

    it('退款带 payment_id；部分退款被拒绝', async () => {
        const calls = stubFetch(() => ({
            refund_id: 'ref_123',
            payment_id: 'pay_gr4RizvMOXFJ6xca3y2tU',
            status: 'succeeded',
        }));
        const plugin = new DodoPaymentsPlugin();
        const result = await plugin.refund(
            { ...ORDER, apiTradeNo: 'pay_gr4RizvMOXFJ6xca3y2tU' },
            7.77,
            CONFIG
        );
        expect(result.success).toBe(true);
        expect(result.thirdPartyRefundNo).toBe('ref_123');
        expect(calls[0].url).toBe('https://test.dodopayments.com/refunds');
        expect(calls[0].body.payment_id).toBe('pay_gr4RizvMOXFJ6xca3y2tU');

        const partial = await plugin.refund(
            { ...ORDER, apiTradeNo: 'pay_gr4RizvMOXFJ6xca3y2tU' },
            1.11,
            CONFIG
        );
        expect(partial.success).toBe(false);
        expect(partial.message).toContain('不支持部分退款');
    });

    it('退款查询映射状态', async () => {
        stubFetch(() => ({
            refund_id: 'ref_123',
            status: 'succeeded',
            amount: 777,
            created_at: '2026-11-27T11:00:00Z',
        }));
        const status = await new DodoPaymentsPlugin().queryRefund('ref_123', CONFIG);
        expect(status.status).toBe('success');
        expect(status.amount).toBe(7.77);
    });
});
