import { describe, it, expect } from 'vitest';
import { normalizePaymentType } from './pay';

/**
 * 支付方式合并：支付宝对外只有一个支付方式 pt_alipay。
 * 网页收款早期标识 alipay_web / pt_alipay_web 必须兼容，否则已接入商户会下不了单。
 */
describe('支付宝支付方式归一化', () => {
    it('旧网页收款标识映射到唯一的 pt_alipay', () => {
        expect(normalizePaymentType('alipay_web')).toBe('pt_alipay');
        expect(normalizePaymentType('pt_alipay_web')).toBe('pt_alipay');
    });

    it('标准支付宝标识保持不变', () => {
        expect(normalizePaymentType('pt_alipay')).toBe('pt_alipay');
        expect(normalizePaymentType('alipay')).toBe('alipay');
    });

    it('其它支付方式不受影响', () => {
        expect(normalizePaymentType('pt_wxpay')).toBe('pt_wxpay');
        expect(normalizePaymentType('xunhupay')).toBe('xunhupay');
        expect(normalizePaymentType('')).toBe('');
    });
});
