import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { stripeRouter } from './stripe';
import { payRouter } from './pay';
import { Env } from '../types/env';

const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const API_KEY = 'sk_test_stripe_compat_77777777';
const RAW_KEY = 'stripe_compat_77777777';
const TRADE_NO = '01999999-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const REFUND_NO = '01999999-cccc-7ddd-8eee-ffffffffffff';

/** 最小 D1 mock：只需支撑认证（全库扫 api_keys）与 order/refund 回读 */
function createMockDb() {
    const apiKeys = [{
        id: 'key-1', user_id: MERCHANT_ID, api_key: RAW_KEY,
        api_key_type: 'hmac-sha256', rsa_public_key: null,
    }];
    const prepare = (sql: string) => ({
        bind: () => ({
            first: async () => {
                if (sql.includes('FROM orders')) {
                    return {
                        id: TRADE_NO, user_id: MERCHANT_ID, out_trade_no: 'ORDER_777',
                        amount: 7.77, status: 0, created_at: '2026-11-27T12:00:00Z',
                        name: '测试订单', payment_type: 'alipay', plugin: 'mockpay', channel_id: 'ch-1',
                    };
                }
                return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
        }),
        first: async () => null,
        all: async () => ({ results: sql.includes('api_keys') ? apiKeys : [] }),
        run: async () => ({ success: true }),
    });
    return { prepare } as unknown as D1Database;
}

function createEnv(): Env {
    return {
        DB: createMockDb(), ENVIRONMENT: 'test', DEFAULT_CURRENCY: 'CNY',
        LOG_LEVEL: 'info', ENABLE_CORS: 'false',
    } as unknown as Env;
}

function authHeaders(key?: string): HeadersInit {
    return {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
}

async function post(path: string, body: any, key?: string) {
    return stripeRouter.fetch(
        new Request(`https://pay.example.com${path}`, {
            method: 'POST', headers: authHeaders(key), body: JSON.stringify(body),
        }),
        createEnv()
    );
}

async function get(path: string, key?: string) {
    return stripeRouter.fetch(
        new Request(`https://pay.example.com${path}`, {
            method: 'GET', headers: authHeaders(key),
        }),
        createEnv()
    );
}

/** mock 内部 payRouter.fetch，返回指定响应（隔离业务逻辑，只测协议转换） */
function mockPayRouter(responses: Array<{ urlIncludes: string; body: any; status?: number }>) {
    return vi.spyOn(payRouter, 'fetch').mockImplementation(async (req: any) => {
        const url = String(req.url);
        const match = responses.find((r) => url.includes(r.urlIncludes));
        return new Response(JSON.stringify(match?.body ?? { code: -1, msg: 'unmocked' }), {
            status: match?.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
}

describe('Stripe 兼容层认证', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('缺少 API Key 时返回 401', async () => {
        const res = await get('/payment_intents');
        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.error.type).toBe('authentication_error');
    });

    it('错误的 API Key 返回 401', async () => {
        const res = await get('/payment_intents', 'sk_test_wrong_key');
        expect(res.status).toBe(401);
    });

    it('裸密钥（无 sk_ 前缀）也能认证', async () => {
        mockPayRouter([{ urlIncludes: '/api/pay/orders', body: { code: 1, count: 0, data: [] } }]);
        const res = await get('/payment_intents', RAW_KEY);
        expect(res.status).toBe(200);
    });
});

describe('POST /v1/payment_intents', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('币种非 cny 时返回 400', async () => {
        const res = await post('/payment_intents', { amount: 777, currency: 'usd' }, API_KEY);
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.param).toBe('currency');
    });

    it('amount 非正整数时返回 400', async () => {
        const res = await post('/payment_intents', { amount: 7.77, currency: 'cny' }, API_KEY);
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.param).toBe('amount');
    });

    it('合法请求返回 Stripe PaymentIntent 对象（金额分转元再转回分）', async () => {
        mockPayRouter([{
            urlIncludes: '/api/pay/submit',
            body: { code: 1, trade_no: TRADE_NO, payurl: 'https://pay.example.com/cashier/x' },
        }]);
        const res = await post('/payment_intents', {
            amount: 777,
            currency: 'cny',
            description: '测试订单',
            metadata: { out_trade_no: 'ORDER_777', type: 'alipay' },
        }, API_KEY);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.object).toBe('payment_intent');
        expect(data.id).toBe(TRADE_NO);
        expect(data.amount).toBe(777);
        expect(data.currency).toBe('cny');
        expect(data.client_secret).toBeNull();
        expect(data.metadata.out_trade_no).toBe('ORDER_777');
    });

    it('内部下单失败时映射为 Stripe 错误', async () => {
        mockPayRouter([{ urlIncludes: '/api/pay/submit', body: { code: -1, msg: '暂不支持该支付方式' } }]);
        const res = await post('/payment_intents', {
            amount: 777, currency: 'cny', metadata: { type: 'unknown' },
        }, API_KEY);
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.message).toBe('暂不支持该支付方式');
    });
});

describe('GET /v1/payment_intents/:id', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('查单返回 Stripe 对象', async () => {
        mockPayRouter([{
            urlIncludes: '/api/pay/query',
            body: {
                code: 1, trade_no: TRADE_NO, out_trade_no: 'ORDER_777',
                money: '7.77', status: 0, addtime: '2026-11-27T12:00:00Z', name: '测试订单',
            },
        }]);
        const res = await get(`/payment_intents/${TRADE_NO}`, API_KEY);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.object).toBe('payment_intent');
        expect(data.amount).toBe(777);
        expect(data.status).toBe('requires_payment_method');
    });

    it('订单不存在映射为 404', async () => {
        mockPayRouter([{ urlIncludes: '/api/pay/query', body: { code: -4, msg: '订单不存在' } }]);
        const res = await get(`/payment_intents/${TRADE_NO}`, API_KEY);
        expect(res.status).toBe(404);
        const data = await res.json() as any;
        expect(data.error.code).toBe('resource_missing');
    });
});

describe('POST /v1/refunds', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('退款成功返回 Stripe Refund 对象', async () => {
        mockPayRouter([{
            urlIncludes: '/api/pay/refund',
            body: { code: 1, refund_no: REFUND_NO, money: 7.77, status: 1 },
        }]);
        const res = await post('/refunds', {
            amount: 777, currency: 'cny', payment_intent: TRADE_NO, reason: '重复支付',
        }, API_KEY);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.object).toBe('refund');
        expect(data.amount).toBe(777);
        expect(data.status).toBe('succeeded');
        expect(data.payment_intent).toBe(TRADE_NO);
    });
});

describe('明确不支持的能力', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('confirm 返回 unsupported_feature', async () => {
        const res = await post(`/payment_intents/${TRADE_NO}/confirm`, {}, API_KEY);
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('unsupported_feature');
    });

    it('customers 返回 unsupported_feature', async () => {
        const res = await get('/customers/cus-1', API_KEY);
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('unsupported_feature');
    });
});
