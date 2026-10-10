import { describe, expect, it, vi } from 'vitest';
import { payRouter } from '../routes/pay';
import { Env } from '../types/env';
import { issueCashierTicket } from '../utils/cashierAuth';
import { hmacSha256 } from '../utils/crypto';
import { buildCashierSignString } from '../utils/cashierAuth';
import { clearDnsCache } from '../utils/netSecurity';

/** 任务 t-mukt0879 集成冒烟：cashier 下单认证 + submit 通知地址 SSRF 校验 */
const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const API_KEY = 'integration-test-api-key';

/** 最小可用的 D1 mock：按 SQL 关键字返回预设结果 */
function createMockDb(options: { channelPlugin?: string } = {}) {
    const channel = {
        id: 'ch-1',
        plugin: options.channelPlugin || 'xunhupay',
        config: '{}',
    };
    const prepare = (sql: string) => ({
        bind: () => ({
            first: async () => {
                if (sql.includes('FROM users') && sql.includes('role = ?')) {
                    return { id: MERCHANT_ID, status: 1, notify_url: 'https://merchant.example.com/notify', return_url: 'https://merchant.example.com/return' };
                }
                if (sql.includes('FROM api_keys')) {
                    return { api_key: API_KEY, api_key_type: 'hmac-sha256' };
                }
                if (sql.includes('FROM channels')) {
                    return channel;
                }
                if (sql.includes('FROM system_config')) {
                    return { value: 'https://pay.example.com' };
                }
                return null;
            },
            all: async () => {
                // 密钥来源统一为 api_keys 表后，认证走 listActiveApiKeys()（.all()）
                if (sql.includes('FROM api_keys')) {
                    return { results: [{ id: 'key-1', user_id: MERCHANT_ID, api_key: API_KEY, name: '默认密钥', api_key_type: 'hmac-sha256', rsa_public_key: null }] };
                }
                return { results: [] };
            },
            run: async () => ({ success: true }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
    });
    return { prepare } as unknown as D1Database;
}

function createEnv(): Env {
    return {
        DB: createMockDb(),
        ENVIRONMENT: 'test',
        DEFAULT_CURRENCY: 'CNY',
        LOG_LEVEL: 'info',
        ENABLE_CORS: 'false',
    } as unknown as Env;
}

async function postCashier(form: Record<string, string>) {
    const body = new URLSearchParams(form);
    return payRouter.fetch(
        new Request('https://pay.example.com/cashier', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        }),
        createEnv()
    );
}

describe('POST /api/pay/cashier 认证', () => {
    it('缺少签名参数时拒绝', async () => {
        const res = await postCashier({ merchant_id: MERCHANT_ID, amount: '7.77', type: 'alipay' });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        // 缺 timestamp 时先命中时间戳校验，缺 sign 时命中签名校验，两者都为 -1
        expect(['签名不能为空', '时间戳不能为空']).toContain(String(data.msg));
    });

    it('时间戳过期时拒绝', async () => {
        const res = await postCashier({
            merchant_id: MERCHANT_ID,
            amount: '7.77',
            type: 'alipay',
            timestamp: String(Date.now() - 600_000),
            sign: 'a'.repeat(64),
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
        expect(String(data.msg)).toContain('过期');
    });

    it('签名错误时拒绝（即便票据有效）', async () => {
        const { ticket } = await issueCashierTicket(MERCHANT_ID, API_KEY);
        const res = await postCashier({
            merchant_id: MERCHANT_ID,
            amount: '7.77',
            type: 'alipay',
            ticket,
            timestamp: String(Date.now()),
            sign: 'b'.repeat(64),
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
        expect(String(data.msg)).toContain('签名验证失败');
    });

    it('票据被篡改（商户不匹配）时拒绝', async () => {
        const { ticket } = await issueCashierTicket('other-merchant-id', API_KEY);
        const timestamp = String(Date.now());
        const sign = await hmacSha256(ticket, buildCashierSignString({
            merchant_id: MERCHANT_ID, amount: '7.77', type: 'alipay', timestamp, name: '在线收银台付款',
        }));
        const res = await postCashier({
            merchant_id: MERCHANT_ID,
            amount: '7.77',
            type: 'alipay',
            ticket,
            timestamp,
            sign,
            name: '在线收银台付款',
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
        expect(String(data.msg)).toContain('票据');
    });

    it('金额被篡改时拒绝（签名绑定到原始金额）', async () => {
        const { ticket } = await issueCashierTicket(MERCHANT_ID, API_KEY);
        const timestamp = String(Date.now());
        const sign = await hmacSha256(ticket, buildCashierSignString({
            merchant_id: MERCHANT_ID, amount: '7.77', type: 'alipay', timestamp, name: '在线收银台付款',
        }));
        const res = await postCashier({
            merchant_id: MERCHANT_ID,
            amount: '7777.00',
            type: 'alipay',
            ticket,
            timestamp,
            sign,
            name: '在线收银台付款',
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
    });

    it('商户服务端直连（不带票据，用 api_key 签名）通过认证', async () => {
        clearDnsCache();
        // 用公网 IP 应答 DoH，绕过 DNS 二次校验的真实网络请求
        vi.stubGlobal('fetch', vi.fn(async (url: any) => {
            if (String(url).includes('cloudflare-dns.com')) {
                return { ok: true, json: async () => ({ Answer: [{ type: 1, data: '93.184.216.34' }] }) };
            }
            return { ok: true, text: async () => 'success', status: 200, json: async () => ({}) };
        }));

        const timestamp = String(Date.now());
        const sign = await hmacSha256(API_KEY, buildCashierSignString({
            merchant_id: MERCHANT_ID, amount: '7.77', type: 'alipay', timestamp, name: '在线收银台付款',
        }));
        const res = await postCashier({
            merchant_id: MERCHANT_ID,
            amount: '7.77',
            type: 'alipay',
            timestamp,
            sign,
            name: '在线收银台付款',
        });
        const data = await res.json() as any;
        // 认证通过后会继续创建订单（插件调用失败会走到 -1/-5，均说明已过认证关）
        expect(data.code).not.toBe(-2);
        expect(String(data.msg)).not.toContain('签名验证失败');
        vi.unstubAllGlobals();
    });
});

describe('POST /api/pay/submit 通知地址 SSRF 校验', () => {
    it('内网通知地址被拒绝', async () => {
        const res = await payRouter.fetch(
            new Request('https://pay.example.com/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    pid: MERCHANT_ID,
                    type: 'alipay',
                    out_trade_no: 'T777777',
                    notify_url: 'https://169.254.169.254/latest/meta-data',
                    name: 'x',
                    money: '7.77',
                    sign: 'c'.repeat(64),
                }),
            }),
            createEnv()
        );
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('通知地址不合法');
    });
});
