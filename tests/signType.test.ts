/**
 * sign_type 服务端权威化验证
 *
 * 背景：/api/pay/submit 等接口原先把客户端传入的 sign_type 当作验签算法，
 * 攻击者可把 hmac-sha256 降级为 md5（当前 md5 实现是 32 位 simpleHash，可穷举碰撞）。
 */
import { describe, expect, it } from 'vitest';
import { generateSignAsync, resolveServerSignType, verifySignAsync } from '../src/utils/crypto';

const API_KEY = 'teaven-test-key-777';
const PARAMS = {
    pid: 'M1001',
    type: 'alipay',
    out_trade_no: 'TEST-777',
    notify_url: 'https://example.com/notify',
    name: '测试商品',
    money: '1.00',
    param: '',
};

describe('resolveServerSignType', () => {
    it('只认服务端密钥记录里的 api_key_type', () => {
        expect(resolveServerSignType({ api_key_type: 'md5' })).toBe('md5');
        expect(resolveServerSignType({ api_key_type: 'HMAC_SHA256' })).toBe('hmac-sha256');
        expect(resolveServerSignType({ api_key_type: 'sha256' })).toBe('hmac-sha256');
        expect(resolveServerSignType({ api_key_type: 'RSA' })).toBe('rsa');
    });

    it('未配置类型时按 hmac-sha256 处理，绝不回退到客户端值', () => {
        expect(resolveServerSignType({ api_key_type: null })).toBe('hmac-sha256');
        expect(resolveServerSignType({ api_key_type: '' })).toBe('hmac-sha256');
        expect(resolveServerSignType(undefined)).toBe('hmac-sha256');
        expect(resolveServerSignType(null)).toBe('hmac-sha256');
    });
});

describe('验签不接受客户端降级', () => {
    it('服务端记录为 hmac-sha256 时，弱哈希(md5)签名被拒绝', async () => {
        const serverType = resolveServerSignType({ api_key_type: 'hmac-sha256' });

        const goodSign = await generateSignAsync(PARAMS, API_KEY, 'hmac-sha256');
        expect(await verifySignAsync(PARAMS, API_KEY, goodSign, serverType)).toBe(true);

        // 攻击者按 md5 算法离线构造的签名（即便他声称 sign_type=MD5）
        const weakSign = await generateSignAsync(PARAMS, API_KEY, 'md5');
        expect(await verifySignAsync(PARAMS, API_KEY, weakSign, serverType)).toBe(false);
    });

    it('存量 md5 商户仍可用（不被强制升级）', async () => {
        const serverType = resolveServerSignType({ api_key_type: 'md5' });
        const md5Sign = await generateSignAsync(PARAMS, API_KEY, 'md5');
        expect(await verifySignAsync(PARAMS, API_KEY, md5Sign, serverType)).toBe(true);

        const hmacSign = await generateSignAsync(PARAMS, API_KEY, 'hmac-sha256');
        expect(await verifySignAsync(PARAMS, API_KEY, hmacSign, serverType)).toBe(false);
    });

    it('RSA 记录不会被伪装成 md5 绕过（当前实现拒绝 RSA 验签，需走 key 参数）', async () => {
        const serverType = resolveServerSignType({ api_key_type: 'rsa' });
        expect(serverType).toBe('rsa');

        const md5Sign = await generateSignAsync(PARAMS, API_KEY, 'md5');
        expect(await verifySignAsync(PARAMS, API_KEY, md5Sign, serverType)).toBe(false);
    });
});
