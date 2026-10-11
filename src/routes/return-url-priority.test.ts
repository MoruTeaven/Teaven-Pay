/**
 * 回跳地址优先级回归测试
 *
 * 背景：Teaven Pay 的商户是把支付能力集成进自己软件里的开发者，
 * 因此「用户支付成功后跳去哪」必须由**下单时传入的 return_url** 决定。
 *
 * 曾经的两个坑：
 *   1) xunhupay 插件压根没把 return_url 传给虎皮椒 → 停在虎皮椒成功页；
 *   2) pay.ts 里 `...channelConfig` 展开在显式字段之后，通道配置里的
 *      returnUrl 会盖掉开发者传入的 return_url（本测试锁定该优先级）。
 *
 * 优先级应为：下单参数 > 通道配置兜底 > 平台结果页
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { payRouter } from './pay';
import { Env } from '../types/env';
import { generateSignAsync } from '../utils/crypto';
import { clearDnsCache } from '../utils/netSecurity';

/**
 * /submit 会先对 notify_url 做 SSRF 校验（含 DoH 解析），
 * 因此这里同时为 DNS 与渠道请求打桩。每个用例前清空 DNS 缓存。
 */
function stubNetwork() {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
        if (String(url).includes('cloudflare-dns.com')) {
            return { ok: true, json: async () => ({ Answer: [{ type: 1, data: '93.184.216.34' }] }) };
        }
        return { ok: true, status: 200, text: async () => 'success', json: async () => ({ errcode: 0, url: 'https://api.xunhupay.com/pay/x' }) };
    }));
}

const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const API_KEY = 'integration-test-api-key';
const DEVELOPER_RETURN_URL = 'https://dev-app.example.com/pay/done';
const CHANNEL_RETURN_URL = 'https://channel-fallback.example.com/return';

/** 捕获插件真正收到的 PluginConfig */
const captured: { configs: any[] } = { configs: [] };

vi.mock('../plugins', () => ({
    getPlugin: () => ({
        id: 'xunhupay',
        name: '虎皮椒',
        createPayment: async (_order: any, config: any) => {
            captured.configs.push(config);
            return { success: true, method: 'jump', payUrl: 'https://api.xunhupay.com/pay/x' };
        },
    }),
}));

/**
 * 模拟真实 D1 的行为：bind 收到 undefined 会抛 D1_TYPE_ERROR。
 *
 * 生产上 /api/pay/submit 曾因此 500——可选参数（clientip/param）用 `as string`
 * 断言后运行时仍是 undefined，直接 bind 就炸。mock 若不校验，这类 bug 测不出来。
 */
function assertBindable(args: any[]) {
    for (const a of args) {
        if (a === undefined) {
            throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
        }
    }
}

/** 通道 config 为明文 JSON（decryptChannelConfig 兼容明文） */
function createEnv(channelConfig: Record<string, unknown>): Env {
    const channel = { id: 'ch-1', plugin: 'xunhupay', config: JSON.stringify(channelConfig) };
    const prepare = (sql: string) => ({
        bind: (...args: any[]) => ({
            __args: assertBindable(args),
            first: async () => {
                if (sql.includes('FROM users')) {
                    return { id: MERCHANT_ID, status: 1, notify_url: '', return_url: null };
                }
                if (sql.includes('FROM api_keys')) {
                    return { api_key: API_KEY, api_key_type: 'hmac-sha256' };
                }
                if (sql.includes('FROM channels')) return channel;
                if (sql.includes('FROM system_config')) return { value: 'https://pay.example.com' };
                if (sql.includes('FROM orders')) return null;
                return null;
            },
            all: async () => {
                if (sql.includes('FROM api_keys')) {
                    return { results: [{ id: 'key-1', user_id: MERCHANT_ID, api_key: API_KEY, name: 'k', api_key_type: 'hmac-sha256', rsa_public_key: null }] };
                }
                return { results: [] };
            },
            run: async () => ({ success: true, meta: { changes: 1 } }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
    });
    return { DB: { prepare } as unknown as D1Database } as unknown as Env;
}

/** 构造一个签名正确的 /api/pay/submit 请求 */
async function postSubmit(env: Env, returnUrl: string | null) {
    const params: Record<string, string> = {
        pid: MERCHANT_ID,
        type: 'pt_wxpay',
        out_trade_no: 'DEV777',
        notify_url: 'https://dev-app.example.com/notify',
        name: '开发者订单',
        money: '7.77',
    };
    if (returnUrl !== null) params.return_url = returnUrl;
    // 服务端验签口径（pay.ts /submit）：只签 type/out_trade_no/notify_url/name/money/param + pid，
    // 不含 return_url。generateSignAsync 内部会排序拼串，这里直接传对象。
    const signedKeys = ['type', 'out_trade_no', 'notify_url', 'name', 'money', 'param'];
    const signEntries: Record<string, string> = { pid: MERCHANT_ID };
    for (const k of signedKeys) {
        const v = params[k];
        if (typeof v === 'string' && v !== '') signEntries[k] = v;
    }
    params.sign = await generateSignAsync(signEntries, API_KEY, 'hmac-sha256');

    return payRouter.fetch(
        new Request('https://pay.example.com/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        }),
        env
    );
}

describe('回跳地址优先级（开发者传入的 return_url 必须赢）', () => {
    beforeEach(() => { captured.configs = []; clearDnsCache(); stubNetwork(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('下单传入 return_url 时，插件拿到的就是它（不被通道配置覆盖）', async () => {
        const env = createEnv({ appId: 'appid-1', appSecret: 'secret-1', returnUrl: CHANNEL_RETURN_URL });

        await postSubmit(env, DEVELOPER_RETURN_URL);

        expect(captured.configs.length).toBe(1);
        expect(captured.configs[0].returnUrl).toBe(DEVELOPER_RETURN_URL);
    });

    it('下单未传 return_url 时，回退到通道配置兜底', async () => {
        const env = createEnv({ appId: 'appid-1', appSecret: 'secret-1', returnUrl: CHANNEL_RETURN_URL });

        await postSubmit(env, null);

        expect(captured.configs[0].returnUrl).toBe(CHANNEL_RETURN_URL);
    });

    it('不传可选参数（clientip/param）时不再 500（D1_TYPE_ERROR 回归）', async () => {
        const env = createEnv({ appId: 'appid-1', appSecret: 'secret-1' });

        // postSubmit 不传 clientip / param，正是触发 D1_TYPE_ERROR 的场景
        const res = await postSubmit(env, null);
        const data: any = await res.json();

        expect(res.status).not.toBe(500);
        expect(data.code).toBe(1);
    });

    it('两者都没有时回退到平台结果页', async () => {
        const env = createEnv({ appId: 'appid-1', appSecret: 'secret-1' });

        await postSubmit(env, null);

        expect(captured.configs[0].returnUrl).toContain('/cashier/');
    });
});
