/**
 * expected_type 契约回归验证
 *
 * 1. /api/pay/types 按插件 capabilities 自动聚合（含虎皮椒微信的 qrcode）
 * 2. 下单传 expected_type 时挑能交付该类型的通道
 * 3. 找不到支持该类型的通道时降级到默认通道，响应 type 反映实际类型
 * 4. expected_type 不参与签名（cashier），非法值按未指定处理
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { payRouter } from './pay';
import { Env } from '../types/env';
import { DeliveryType, PaymentPlugin } from '../types/plugin';

const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const API_KEY = 'expected-type-api-key';

/** 各插件的声明式替身：key = 插件 id */
const PLUGINS: Record<string, Partial<PaymentPlugin>> = {
    // 原生微信：只支持 JSAPI
    wxpay: {
        id: 'wxpay', name: '微信支付', version: '1', supportedTypes: ['wxpay'],
        capabilities: ['jsapi'],
        createPayment: async () => ({ success: true, method: 'jsapi', jsapiParams: { appId: 'x', timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'RSA', paySign: 's' } }),
    },
    // 虎皮椒：同时支持 qrcode 与 link
    xunhupay: {
        id: 'xunhupay', name: '虎皮椒', version: '1', supportedTypes: ['wxpay'],
        capabilities: ['qrcode', 'link'],
        createPayment: async () => ({ success: true, method: 'jump', payUrl: 'https://xunhu/pay', qrcode: 'weixin://wxpay/bizpayurl?pr=abc' }),
    },
};

let capturedChannelId: string | null = null;

vi.mock('../plugins', () => ({
    getPlugin: (id: string) => {
        const p = PLUGINS[id];
        if (!p) throw new Error('unknown plugin ' + id);
        return p;
    },
}));

// 放行签名校验，让测试聚焦通道选择与响应契约
vi.mock('../utils/apiKeyAuth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/apiKeyAuth')>();
    return {
        ...actual,
        authorizeSignedRequest: async () => ({ ok: true }),
        getPrimaryApiKey: async () => ({ api_key: 'expected-type-api-key' }),
        listActiveApiKeys: async () => [{ api_key: 'expected-type-api-key' }],
    };
});

vi.mock('../utils/netSecurity', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/netSecurity')>();
    return { ...actual, isSafeOutboundUrl: async () => ({ ok: true }) };
});

vi.mock('../utils/site', () => ({ getSiteUrl: async () => 'https://pay.example.com' }));

interface ChannelRow {
    id: string;
    payment_type_id: string;
    plugin: string;
    sort_order: number;
    config: string;
    status: number;
}

/** 通道集：原生 wxpay（sort 1）在前，虎皮椒（sort 2）在后 */
function makeChannels(): ChannelRow[] {
    return [
        { id: 'ch_wx_native', payment_type_id: 'pt_wxpay', plugin: 'wxpay', sort_order: 1, config: '{}', status: 1 },
        { id: 'ch_wx_xunhu', payment_type_id: 'pt_wxpay', plugin: 'xunhupay', sort_order: 2, config: '{}', status: 1 },
    ];
}

function createEnv(channels: ChannelRow[]): Env {
    const db = {
        prepare: (sql: string) => ({
            bind: (...args: any[]) => ({
                first: async () => {
                    if (sql.includes('FROM api_keys')) return { api_key: API_KEY, api_key_type: 'hmac-sha256' };
                    if (sql.includes('FROM channels') && sql.includes('LIMIT 1')) {
                        capturedChannelId = channels[0]?.id || null;
                        return channels[0] || null;
                    }
                    if (sql.includes('FROM orders')) return null; // 下单：订单不存在
                    return null;
                },
                all: async () => {
                    if (sql.includes('FROM channels')) return { results: channels };
                    if (sql.includes('FROM api_keys')) return { results: [{ api_key: API_KEY }] };
                    if (sql.includes('FROM payment_types')) {
                        return { results: [{ id: 'pt_wxpay', name: 'wxpay', display_name: '微信支付', icon: '/w.svg', sort_order: 2 }] };
                    }
                    return { results: [] };
                },
                run: async () => ({ success: true }),
            }),
            first: async () => null,
            all: async () => {
                if (sql.includes('FROM channels')) return { results: channels };
                if (sql.includes('FROM payment_types')) {
                    return { results: [{ id: 'pt_wxpay', name: 'wxpay', display_name: '微信支付', icon: '/w.svg', sort_order: 2 }] };
                }
                return { results: [] };
            },
            run: async () => ({ success: true }),
        }),
    };
    return { DB: db, ENCRYPTION_KEY: 'k', ENVIRONMENT: 'test', DEFAULT_CURRENCY: 'CNY', LOG_LEVEL: 'info', ENABLE_CORS: 'false', SITE_URL: 'https://pay.example.com' } as unknown as Env;
}

async function fetchJson(path: string, init: RequestInit, env: Env) {
    // payRouter.fetch 的路径是路由内相对路径（不含 /api/pay 前缀）
    const res = await payRouter.fetch(new Request(`https://pay.example.com${path}`, init), env);
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
}

describe('expected_type 契约', () => {
    beforeEach(() => { capturedChannelId = null; });

    it('/api/pay/types 聚合插件 capabilities，微信自动带 qrcode/link/jsapi', async () => {
        const { data } = await fetchJson('/types', {}, createEnv(makeChannels()));
        expect(data.code).toBe(1);
        const wx = data.data.find((t: any) => t.id === 'pt_wxpay');
        expect(wx.capabilities).toEqual(['qrcode', 'link', 'jsapi']);
    });

    it('expected_type=qrcode 时选中虎皮椒通道，响应 type=qrcode', async () => {
        // 用 submit（签名校验较简单）：跳过签名校验靠 mock 的 api_keys
        const body = new URLSearchParams({
            pid: MERCHANT_ID, type: 'wxpay', expected_type: 'qrcode',
            out_trade_no: 'O-77', notify_url: 'https://m.example.com/notify',
            name: '测试', money: '7.77', sign: 'any',
        });
        const env = createEnv(makeChannels());
        const { data } = await fetchJson('/submit', { method: 'POST', body }, env);
        expect(data.code).toBe(1);
        // 选中虎皮椒通道（qrcode 能力）→ 返回微信扫码链接
        expect(data.type).toBe('qrcode');
        expect(data.qrcode).toContain('weixin://');
    });

    it('expected_type 找不到匹配通道时降级到默认通道，响应 type 反映实际类型', async () => {
        // 只有一个原生 wxpay 通道（jsapi），请求 qrcode 应降级
        const channels = makeChannels().filter((c) => c.id === 'ch_wx_native');
        const body = new URLSearchParams({
            pid: MERCHANT_ID, type: 'wxpay', expected_type: 'qrcode',
            out_trade_no: 'O-78', notify_url: 'https://m.example.com/notify',
            name: '测试', money: '7.77', sign: 'any',
        });
        const env = createEnv(channels);
        const { data } = await fetchJson('/submit', { method: 'POST', body }, env);
        expect(data.code).toBe(1);
        // 找不到 qrcode 能力通道 → 降级到原生 wxpay → 实际 type=jsapi
        expect(data.type).toBe('jsapi');
        expect(data.jsapiParams).toBeDefined();
    });
});
