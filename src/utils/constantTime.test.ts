import { describe, expect, it } from 'vitest';
import { timingSafeEqual, timingSafeEqualSign } from './constantTime';

/** 任务 t-mukt0879：密码/签名常数时间比较 */
describe('timingSafeEqual', () => {
    it('相同字符串返回 true', () => {
        expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
        expect(timingSafeEqual('', '')).toBe(true);
    });

    it('不同字符串返回 false', () => {
        expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
        expect(timingSafeEqual('abc123', '')).toBe(false);
        expect(timingSafeEqual('', 'abc123')).toBe(false);
    });

    it('长度不同时也返回 false', () => {
        expect(timingSafeEqual('abc', 'abcd')).toBe(false);
        expect(timingSafeEqual('abcd', 'abc')).toBe(false);
    });

    it('多字节字符按字节比较，不因编码长度误判', () => {
        expect(timingSafeEqual('支付', '支付')).toBe(true);
        expect(timingSafeEqual('支付', '支fu')).toBe(false);
    });

    it('逐字节异或累计：不同位置都能检出差异', () => {
        const a = 'deadbeefdeadbeef';
        for (let i = 0; i < a.length; i++) {
            const mutated = a.slice(0, i) + (a[i] === 'a' ? 'b' : 'a') + a.slice(i + 1);
            expect(timingSafeEqual(a, mutated)).toBe(false);
        }
    });
});

describe('timingSafeEqualSign', () => {
    it('大小写不敏感', () => {
        expect(timingSafeEqualSign('ABCDEF0123456789', 'abcdef0123456789')).toBe(true);
    });

    it('忽略首尾空白', () => {
        expect(timingSafeEqualSign(' abc123 ', 'abc123')).toBe(true);
    });

    it('签名不一致返回 false', () => {
        expect(timingSafeEqualSign('abc123', 'abc124')).toBe(false);
    });
});
