import { describe, expect, it, vi } from 'vitest';
import { XunhupayPlugin } from './xunhupay';

/**
 * 虎皮椒同步跳转回归测试
 *
 * 背景：不传 return_url 时，虎皮椒支付成功后会停留在自己的成功页
 * （https://api.xunhupay.com/payments/home/success），用户永远回不到商户站点。
 * 这里锁死「return_url / callback_url 必须透传到下单请求」这一行为。
 */
const ORDER = {
    tradeNo: 'T777777',
    outTradeNo: 'OUT777777',
    amount: 7.77,
    actualAmount: 7.77,
    subject: '测试商品',
    clientIp: '127.0.0.1',
    createdAt: new Date().toISOString(),
};

function captureFetch(payload: Record<string, unknown> = { errcode: 0, url: 'https://api.xunhupay.com/pay/x' }) {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
        return { json: async () => payload };
    }));
    return calls;
}

describe('XunhupayPlugin.createPayment 同步跳转', () => {
    it('配置了 returnUrl 时随下单请求透传 return_url', async () => {
        const calls = captureFetch();
        const plugin = new XunhupayPlugin();

        await plugin.createPayment(ORDER as any, {
            appId: 'appid-1',
            appSecret: 'secret-1',
            notifyUrl: 'https://pay.example.com/notify/xunhupay',
            returnUrl: 'https://merchant.example.com/return',
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.return_url).toBe('https://merchant.example.com/return');
        // 签名必须覆盖 return_url：hash 变化说明该字段参与了签名
        const withoutReturn = captureFetch();
        await plugin.createPayment(ORDER as any, {
            appId: 'appid-1',
            appSecret: 'secret-1',
            notifyUrl: 'https://pay.example.com/notify/xunhupay',
        });
        expect(withoutReturn[0].body.return_url).toBeUndefined();
        expect(withoutReturn[0].body.hash).not.toBe(calls[0].body.hash);

        vi.unstubAllGlobals();
    });

    it('callbackUrl 透传为 callback_url', async () => {
        const calls = captureFetch();
        const plugin = new XunhupayPlugin();

        await plugin.createPayment(ORDER as any, {
            appId: 'appid-1',
            appSecret: 'secret-1',
            notifyUrl: 'https://pay.example.com/notify/xunhupay',
            returnUrl: 'https://merchant.example.com/return',
            callbackUrl: 'https://merchant.example.com/pay',
        });

        expect(calls[0].body.callback_url).toBe('https://merchant.example.com/pay');
        vi.unstubAllGlobals();
    });

    it('未配置跳转地址时不传空字段（空值不参与签名）', async () => {
        const calls = captureFetch();
        const plugin = new XunhupayPlugin();

        await plugin.createPayment(ORDER as any, {
            appId: 'appid-1',
            appSecret: 'secret-1',
            notifyUrl: 'https://pay.example.com/notify/xunhupay',
        });

        expect(calls[0].body.return_url).toBeUndefined();
        expect(calls[0].body.callback_url).toBeUndefined();
        vi.unstubAllGlobals();
    });
});
