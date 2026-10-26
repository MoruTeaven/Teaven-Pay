/**
 * API 缺口整改验证（B-1 ~ B-4）
 *
 * B-1 成功码不统一：refund / close / refundquery 返回 code:0 表示成功
 * B-2 退款未真正执行：只写库就返回「退款成功」，渠道从未收到请求
 * B-3 订单状态接口无认证：任何人凭 trade_no 即可查询订单状态与金额
 * B-4 易支付 act=settle 转发到不存在的 /api/merchant/settle，必然 404
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { payRouter } from './pay';
import { Env } from '../types/env';
import { generateSignAsync } from '../utils/crypto';
import { issueOrderStatusToken, verifyOrderStatusToken, ORDER_STATUS_TOKEN_TTL_MS } from '../utils/orderStatusAuth';

const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const OTHER_MERCHANT_ID = '01999999-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const API_KEY = 'integration-test-api-key';
const TRADE_NO = '01999999-cccc-7ddd-8eee-ffffffffffff';
const OTHER_TRADE_NO = '01999999-dddd-7eee-8fff-000000000000';

/** 渠道退款插件的行为开关 */
let refundBehavior: { success: boolean; thirdPartyRefundNo?: string; message?: string; throwError?: boolean } = {
    success: true,
    thirdPartyRefundNo: 'tp-refund-777',
};

/** 记录回滚 SQL 是否执行，用于验证渠道失败时不留悬空成功态 */
let executedSql: string[] = [];

/**
 * 最小 D1 替身：
 *  - orders：一条已支付、可退 7.77 的订单
 *  - channels / api_keys：认证与渠道解析所需
 *  - refunds：退款落库记录
 */
function createMockDb(options: { order?: any; channel?: any } = {}) {
    const order = options.order ?? {
        id: TRADE_NO,
        user_id: MERCHANT_ID,
        out_trade_no: 'OUT-777',
        payment_type: 'pt_alipay',
        channel_id: 'ch-1',
        plugin: 'alipay',
        amount: 7.77,
        actual_amount: 7.77,
        status: 1,
        name: '测试商品',
        buyer_ip: '1.2.3.4',
        refund_amount: 0,
        created_at: '2026-10-01T00:00:00.000Z',
    };
    const channel = options.channel ?? {
        id: 'ch-1',
        plugin: 'alipay',
        // 明文 JSON（decryptChannelConfig 兼容明文）：退款需要真实渠道凭据才会发起
        config: JSON.stringify({ appId: 'app-777', appSecret: 'secret-777' }),
    };

    const prepare = (sql: string) => {
        executedSql.push(sql);
        const statement = {
            bind: (...args: any[]) => ({
                first: async () => {
                    if (sql.includes('FROM users')) {
                        const id = args[0];
                        if (id !== MERCHANT_ID && id !== OTHER_MERCHANT_ID) return null;
                        return { id, status: 1 };
                    }
                    if (sql.includes('FROM orders')) {
                        // status 接口按 tradeNo 查；refund 按 trade_no + user_id 查
                        if (args[0] === order.id || args[0] === OTHER_TRADE_NO) return order;
                        return null;
                    }
                    if (sql.includes('FROM channels')) return channel;
                    if (sql.includes('FROM refunds')) return null;
                    return null;
                },
                all: async () => {
                    if (sql.includes('FROM api_keys')) {
                        return { results: [{ id: 'key-1', user_id: MERCHANT_ID, api_key: API_KEY, name: '默认密钥', api_key_type: 'hmac-sha256', rsa_public_key: null }] };
                    }
                    return { results: [] };
                },
                run: async () => ({ success: true, meta: { changes: 1 } }),
            }),
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        return statement;
    };
    return { prepare } as unknown as D1Database;
}

function createEnv(db: D1Database): Env {
    return { DB: db, ENCRYPTION_KEY: 'test-encryption-key', ENVIRONMENT: 'test', DEFAULT_CURRENCY: 'CNY', LOG_LEVEL: 'info', ENABLE_CORS: 'false' } as unknown as Env;
}

function callWithDb(db: D1Database, path: string, init: RequestInit = {}) {
    return payRouter.fetch(new Request(`https://pay.example.com${path}`, init), createEnv(db));
}

beforeEach(() => {
    executedSql = [];
    refundBehavior = { success: true, thirdPartyRefundNo: 'tp-refund-777' };
    // 插件注册表里给 alipay 打桩：真实实现会发网络请求，这里只关心路由层行为
    vi.mock('./../plugins', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../plugins')>();
        return {
            ...actual,
            getPlugin: () => ({
                id: 'alipay',
                name: '支付宝',
                version: '1.0.0',
                supportedTypes: ['alipay'],
                createPayment: async () => ({ success: false, method: 'qrcode' as const }),
                verifyNotify: async () => ({ success: false, tradeNo: '', outTradeNo: '', status: 'failed' as const }),
                queryOrder: async () => ({ status: 'pending' as const }),
                queryRefund: async () => ({ status: 'processing' as const }),
                refund: async () => {
                    if (refundBehavior.throwError) throw new Error(refundBehavior.message || '渠道网络异常');
                    return {
                        success: refundBehavior.success,
                        refundNo: 'rf-777',
                        thirdPartyRefundNo: refundBehavior.thirdPartyRefundNo,
                        message: refundBehavior.message,
                    };
                },
            }),
        };
    });
    vi.resetModules();
});

describe('B-3 订单状态接口认证', () => {
    it('无凭证时不再返回订单状态（整改前任何人可查）', async () => {
        const db = createMockDb();
        const res = await callWithDb(db, `/status/${TRADE_NO}`);
        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('缺少订单访问凭证');
    });

    it('伪造的票据被拒绝', async () => {
        const db = createMockDb();
        const res = await callWithDb(db, `/status/${TRADE_NO}?token=v1.${TRADE_NO}.${Date.now() + 60_000}.${'a'.repeat(64)}`);
        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
    });

    it('票据绑定单号：本单的票据查不了别的订单', async () => {
        const { token } = await issueOrderStatusToken(TRADE_NO, API_KEY);
        // 同一把密钥签出的票据，却指向另一个 tradeNo
        const valid = await verifyOrderStatusToken(token, OTHER_TRADE_NO, [API_KEY]);
        expect(valid).toBe(false);
    });

    it('票据过期后失效', async () => {
        const { token } = await issueOrderStatusToken(TRADE_NO, API_KEY);
        const parts = token.split('.');
        parts[2] = String(Date.now() - 1000);
        const expired = parts.join('.');
        const valid = await verifyOrderStatusToken(expired, TRADE_NO, [API_KEY]);
        expect(valid).toBe(false);
    });

    it('有效票据可查询订单状态', async () => {
        const { token } = await issueOrderStatusToken(TRADE_NO, API_KEY);
        const db = createMockDb();
        const res = await callWithDb(db, `/status/${TRADE_NO}`, {
            headers: { 'X-Order-Token': token },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        expect(data.status).toBe(1);
    });

    it('商户签名可查询自己的订单', async () => {
        const db = createMockDb();
        const timestamp = String(Date.now());
        const sign = await generateSignAsync({ pid: MERCHANT_ID, trade_no: TRADE_NO, timestamp }, API_KEY, 'hmac-sha256');
        const res = await callWithDb(db, `/status/${TRADE_NO}?pid=${MERCHANT_ID}&trade_no=${TRADE_NO}&timestamp=${timestamp}&sign=${sign}`);
        const data = await res.json() as any;
        expect(data.code).toBe(1);
    });

    it('商户签名不能查别人的订单（越权被拒）', async () => {
        const db = createMockDb();
        const timestamp = String(Date.now());
        const sign = await generateSignAsync({ pid: OTHER_MERCHANT_ID, trade_no: TRADE_NO, timestamp }, API_KEY, 'hmac-sha256');
        const res = await callWithDb(db, `/status/${TRADE_NO}?pid=${OTHER_MERCHANT_ID}&trade_no=${TRADE_NO}&timestamp=${timestamp}&sign=${sign}`);
        // 跨商户查询一律拒绝：无论落在「无启用密钥」还是「订单不属于该商户」，都不能返回状态
        expect([401, 403]).toContain(res.status);
    });

    it('票据有效期覆盖收银台轮询窗口', () => {
        expect(ORDER_STATUS_TOKEN_TTL_MS).toBeGreaterThan(600_000);
    });
});

describe('B-2 退款必须打给真实支付渠道', () => {
    it('渠道退款成功时返回 code=1 并落退款记录', async () => {
        const db = createMockDb();
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: TRADE_NO, money: '7.77', key: API_KEY });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        expect(data.refund_no).toBeTruthy();
        // 整改前不会有任何 INSERT INTO refunds，因为渠道调用是 TODO
        expect(executedSql.some((sql) => sql.includes('INSERT INTO refunds'))).toBe(true);
    });

    it('渠道退款失败时返回失败并回滚退款占位（不再谎报成功）', async () => {
        refundBehavior = { success: false, message: '余额不足' };
        const db = createMockDb();
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: TRADE_NO, money: '7.77', key: API_KEY });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('退款失败');
        // 失败必须释放占位额度，否则这笔钱再也退不出去
        expect(executedSql.some((sql) => sql.includes('refund_amount = refund_amount - ?'))).toBe(true);
        // 且不能留下退款记录
        expect(executedSql.some((sql) => sql.includes('INSERT INTO refunds'))).toBe(false);
    });

    it('渠道抛异常时同样按失败处理', async () => {
        refundBehavior = { success: false, throwError: true, message: '渠道网络异常' };
        const db = createMockDb();
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: TRADE_NO, money: '7.77', key: API_KEY });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
    });

    it('订单未记录支付渠道时拒绝退款（无法向渠道发起）', async () => {
        const db = createMockDb({ order: { id: TRADE_NO, user_id: MERCHANT_ID, out_trade_no: 'OUT-777', amount: 7.77, status: 1, plugin: null, channel_id: null, refund_amount: 0, created_at: 'x', actual_amount: 7.77, buyer_ip: '', name: '' } });
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: TRADE_NO, money: '7.77', key: API_KEY });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('无法向渠道发起退款');
    });
});

describe('B-1 成功码统一为 1', () => {
    it('关闭订单返回 code=1', async () => {
        const db = createMockDb({ order: { id: TRADE_NO, user_id: MERCHANT_ID, out_trade_no: 'OUT-777', amount: 7.77, status: 0, plugin: 'alipay', channel_id: 'ch-1', refund_amount: 0, created_at: 'x' } });
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: TRADE_NO, key: API_KEY });
        const res = await callWithDb(db, '/close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        expect(String(data.msg)).toContain('订单关闭成功');
    });
});
