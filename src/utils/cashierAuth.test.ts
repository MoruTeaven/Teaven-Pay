import { describe, expect, it } from 'vitest';
import { buildCashierSignString, isTimestampFresh, issueCashierTicket, verifyCashierSign, verifyCashierTicket } from './cashierAuth';
import { hmacSha256 } from './crypto';

/** 任务 t-mukt0879：cashier 下单加认证/签名 */
const API_KEY = 'test-api-key-77777777';
const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';

describe('cashierAuth - 票据', () => {
    it('签发后可验签通过', async () => {
        const { ticket } = await issueCashierTicket(MERCHANT_ID, API_KEY);
        const payload = await verifyCashierTicket(ticket, API_KEY);
        expect(payload).not.toBeNull();
        expect(payload?.merchantId).toBe(MERCHANT_ID);
    });

    it('密钥错误时验签失败', async () => {
        const { ticket } = await issueCashierTicket(MERCHANT_ID, API_KEY);
        expect(await verifyCashierTicket(ticket, 'wrong-key')).toBeNull();
    });

    it('被篡改的票据验签失败', async () => {
        const { ticket } = await issueCashierTicket(MERCHANT_ID, API_KEY);
        const parts = ticket.split('.');
        parts[1] = '01999999-aaaa-7bbb-8ccc-eeeeeeeeeeee';
        expect(await verifyCashierTicket(parts.join('.'), API_KEY)).toBeNull();
    });

    it('畸形票据验签失败', async () => {
        for (const bad of ['', 'abc', 'v1.x.y.z.sig', 'v2.a.b.c.d']) {
            expect(await verifyCashierTicket(bad, API_KEY)).toBeNull();
        }
    });

    it('过期票据验签失败', async () => {
        const nonce = 'a'.repeat(32);
        const expiredAt = Date.now() - 1000;
        const body = ['v1', MERCHANT_ID, nonce, String(expiredAt)].join('.');
        const sig = await hmacSha256(API_KEY, body);
        expect(await verifyCashierTicket([body, sig].join('.'), API_KEY)).toBeNull();
    });
});

describe('cashierAuth - 下单签名', () => {
    const params = { merchant_id: MERCHANT_ID, amount: '7.77', type: 'alipay', timestamp: '1700000000000' };

    it('待签串按字段名排序拼接', () => {
        expect(buildCashierSignString(params)).toBe('amount=7.77&merchant_id=' + MERCHANT_ID + '&timestamp=1700000000000&type=alipay');
    });

    it('正确签名通过校验', async () => {
        const sign = await hmacSha256(API_KEY, buildCashierSignString(params));
        expect(await verifyCashierSign(params, API_KEY, sign)).toBe(true);
    });

    it('金额被篡改后签名校验失败', async () => {
        const sign = await hmacSha256(API_KEY, buildCashierSignString(params));
        expect(await verifyCashierSign({ ...params, amount: '7777.00' }, API_KEY, sign)).toBe(false);
    });

    it('商户 ID 被篡改后签名校验失败', async () => {
        const sign = await hmacSha256(API_KEY, buildCashierSignString(params));
        expect(await verifyCashierSign({ ...params, merchant_id: 'other-merchant' }, API_KEY, sign)).toBe(false);
    });

    it('非法签名格式直接拒绝', async () => {
        for (const bad of ['', 'xyz', 'deadbeef']) {
            expect(await verifyCashierSign(params, API_KEY, bad)).toBe(false);
        }
    });

    it('大写签名与小写签名等价', async () => {
        const sign = await hmacSha256(API_KEY, buildCashierSignString(params));
        expect(await verifyCashierSign(params, API_KEY, sign.toUpperCase())).toBe(true);
    });
});

describe('cashierAuth - 时间戳新鲜度', () => {
    it('当前时间通过', () => {
        expect(isTimestampFresh(String(Date.now()))).toBe(true);
    });

    it('超出容差的时间戳被拒绝', () => {
        expect(isTimestampFresh(String(Date.now() - 600_000))).toBe(false);
        expect(isTimestampFresh(String(Date.now() + 600_000))).toBe(false);
    });

    it('非法时间戳被拒绝', () => {
        for (const bad of ['', 'abc', '0', '-1']) {
            expect(isTimestampFresh(bad)).toBe(false);
        }
    });
});
