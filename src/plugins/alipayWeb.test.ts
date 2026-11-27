import { describe, it, expect, beforeAll } from 'vitest';
import { AlipayWebPlugin } from './alipayWeb';
import { buildAlipaySignString, extractRawJsonValue, formatAlipayTimestamp } from '../utils/alipayCrypto';
import type { OrderInfo, PluginConfig } from '../types/plugin';

const order: OrderInfo = {
    tradeNo: '0199f0000000000000000000001',
    outTradeNo: 'OUT_777',
    amount: 77.7,
    actualAmount: 77.7,
    subject: '测试商品 <script>',
    clientIp: '127.0.0.1',
    createdAt: '2026-11-27T10:00:00.000Z'
};

let config: PluginConfig;

function bufToB64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

beforeAll(async () => {
    // 生成真实 RSA 密钥对（PKCS#8 私钥 + SPKI 公钥），转 PEM 供插件使用
    const kp = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify']
    );
    const pkcs8 = bufToB64(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const spki = bufToB64(await crypto.subtle.exportKey('spki', kp.publicKey));
    config = {
        appId: '2021000000000000',
        appSecret: 'unused-when-privateKey-present',
        privateKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
        alipayPublicKey: `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`,
        notifyUrl: 'https://pay.example.com/notify/alipay_web',
        returnUrl: 'https://pay.example.com/result/0199f0000000000000000000001'
    };
});

describe('alipayCrypto 工具', () => {
    it('待签名串按 key 排序并剔除 sign/空值', () => {
        expect(buildAlipaySignString({ b: '2', a: '1', sign: 'X', empty: '', n: null as any }))
            .toBe('a=1&b=2');
    });

    it('时间戳为 yyyy-MM-dd HH:mm:ss 且按北京时间', () => {
        const ts = formatAlipayTimestamp(new Date('2026-11-27T02:00:00.000Z'));
        expect(ts).toBe('2026-11-27 10:00:00');
    });

    it('从网关响应提取原始 JSON 片段（保留转义）', () => {
        const text = '{"alipay_trade_query_response":{"trade_status":"TRADE_SUCCESS","trade_no":"T1"},"sign":"abc"}';
        expect(extractRawJsonValue(text, 'alipay_trade_query_response'))
            .toBe('{"trade_status":"TRADE_SUCCESS","trade_no":"T1"}');
    });
});

describe('AlipayWebPlugin 下单', () => {
    it('缺配置时失败', async () => {
        const plugin = new AlipayWebPlugin();
        const result = await plugin.createPayment(order, { appId: '', appSecret: '' });
        expect(result.success).toBe(false);
        expect(result.method).toBe('form');
    });

    it('返回自动提交 form：含 page.pay / FAST_INSTANT_TRADE_PAY / 金额 / subject 转义 / notify+return', async () => {
        const plugin = new AlipayWebPlugin();
        const result = await plugin.createPayment(order, config);
        expect(result.success).toBe(true);
        expect(result.method).toBe('form');
        const html = result.formHtml || '';
        expect(html).toContain('alipay.trade.page.pay');
        expect(html).toContain('FAST_INSTANT_TRADE_PAY');
        expect(html).toContain('77.70');
        expect(html).toContain('&lt;script&gt;');       // subject 已转义，不能注入脚本
        expect(html).toContain('name="notify_url"');
        expect(html).toContain('name="return_url"');
        expect(html).toContain('name="sign"');
        expect(html).toContain('.submit()');            // 自动提交表单
    });
});
