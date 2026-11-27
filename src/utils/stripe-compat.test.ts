import { describe, expect, it } from 'vitest';
import {
    minorUnitsToYuan,
    yuanToMinorUnits,
    isSupportedCurrency,
    mapOrderStatusToStripe,
    mapRefundStatusToStripe,
    buildPaymentIntent,
    buildRefund,
    buildList,
    stripeError,
    stripeErrors,
} from './stripe-compat';

describe('金额转换（分 ↔ 元）', () => {
    it('分转元：777 分 → 7.77 元', () => {
        expect(minorUnitsToYuan(777)).toBe('7.77');
    });

    it('分转元：不足一角补零，1005 分 → 10.05 元', () => {
        expect(minorUnitsToYuan(1005)).toBe('10.05');
    });

    it('分转元：拒绝非正整数', () => {
        expect(() => minorUnitsToYuan(0)).toThrow(RangeError);
        expect(() => minorUnitsToYuan(-1)).toThrow(RangeError);
        expect(() => minorUnitsToYuan(7.77)).toThrow(RangeError);
    });

    it('元转分：7.77 → 777，处理浮点尾差', () => {
        expect(yuanToMinorUnits('7.77')).toBe(777);
        expect(yuanToMinorUnits(10.05)).toBe(1005);
        expect(yuanToMinorUnits('77.7')).toBe(7770);
    });

    it('分转元再转分可逆', () => {
        for (const cents of [1, 7, 77, 777, 1005, 99999]) {
            expect(yuanToMinorUnits(minorUnitsToYuan(cents))).toBe(cents);
        }
    });
});

describe('币种校验', () => {
    it('只接受 cny（大小写不敏感）', () => {
        expect(isSupportedCurrency('cny')).toBe(true);
        expect(isSupportedCurrency('CNY')).toBe(true);
        expect(isSupportedCurrency(' Cny ')).toBe(true);
    });

    it('拒绝其它币种与空值', () => {
        expect(isSupportedCurrency('usd')).toBe(false);
        expect(isSupportedCurrency('')).toBe(false);
        expect(isSupportedCurrency(undefined)).toBe(false);
        expect(isSupportedCurrency(777)).toBe(false);
    });
});

describe('状态映射', () => {
    it('订单 0/1/2/3 → Stripe status', () => {
        expect(mapOrderStatusToStripe(0)).toBe('requires_payment_method');
        expect(mapOrderStatusToStripe(1)).toBe('succeeded');
        expect(mapOrderStatusToStripe(2)).toBe('succeeded');
        expect(mapOrderStatusToStripe(3)).toBe('canceled');
    });

    it('退款 0/1/2 → Stripe status', () => {
        expect(mapRefundStatusToStripe(0)).toBe('pending');
        expect(mapRefundStatusToStripe(1)).toBe('succeeded');
        expect(mapRefundStatusToStripe(2)).toBe('failed');
    });
});

describe('对象构建', () => {
    it('PaymentIntent 形状正确，client_secret 为 null', () => {
        const pi = buildPaymentIntent({
            id: '01999999-aaaa-7bbb-8ccc-dddddddddddd',
            amount: '7.77',
            status: 0,
            createdAt: '2026-11-27T12:00:00Z',
            description: '测试订单',
            outTradeNo: 'ORDER_777',
        });
        expect(pi.object).toBe('payment_intent');
        expect(pi.amount).toBe(777);
        expect(pi.amount_received).toBe(0);
        expect(pi.status).toBe('requires_payment_method');
        expect(pi.currency).toBe('cny');
        expect(pi.client_secret).toBeNull();
        expect(pi.metadata.out_trade_no).toBe('ORDER_777');
        expect(pi.created).toBe(Math.floor(Date.parse('2026-11-27T12:00:00Z') / 1000));
    });

    it('已支付订单 amount_received = amount', () => {
        const pi = buildPaymentIntent({
            id: 'pi-1', amount: 10.05, status: 1, createdAt: '2026-11-27T12:00:00Z',
        });
        expect(pi.status).toBe('succeeded');
        expect(pi.amount).toBe(1005);
        expect(pi.amount_received).toBe(1005);
    });

    it('未支付订单带 next_action 交付信息', () => {
        const pi = buildPaymentIntent({
            id: 'pi-2', amount: '7.77', status: 0, createdAt: '2026-11-27T12:00:00Z',
            delivery: { type: 'qrcode', qrcode: 'weixin://wxpay/xxx' },
        });
        expect(pi.next_action).toMatchObject({ type: 'teaven_pay_display', display_type: 'qrcode', qrcode: 'weixin://wxpay/xxx' });
    });

    it('Refund 对象形状正确', () => {
        const refund = buildRefund({
            id: 're-1', amount: '7.77', status: 0,
            createdAt: '2026-11-27T12:00:00Z', paymentIntentId: 'pi-1', reason: '重复支付',
        });
        expect(refund.object).toBe('refund');
        expect(refund.amount).toBe(777);
        expect(refund.status).toBe('pending');
        expect(refund.payment_intent).toBe('pi-1');
        expect(refund.reason).toBe('重复支付');
    });

    it('列表响应形状正确', () => {
        const list = buildList('payment_intents', [{ id: 'pi-1' }], true);
        expect(list).toMatchObject({ object: 'list', data: [{ id: 'pi-1' }], has_more: true, url: '/v1/payment_intents' });
    });
});

describe('错误模型', () => {
    it('错误对象形状含 status_code', () => {
        const err = stripeErrors.notFound('找不到订单');
        expect(err.error).toMatchObject({ type: 'invalid_request_error', code: 'resource_missing', message: '找不到订单', status_code: 404 });
    });

    it('非法 status_code 回落 400', () => {
        const err = stripeError('api_error', 'x', 999);
        expect(err.error.status_code).toBe(400);
    });

    it('认证错误 401', () => {
        expect(stripeErrors.unauthenticated().error.status_code).toBe(401);
    });

    it('不支持能力错误 400', () => {
        const err = stripeErrors.unsupported('3DS');
        expect(err.error.code).toBe('unsupported_feature');
        expect(err.error.status_code).toBe(400);
    });
});
