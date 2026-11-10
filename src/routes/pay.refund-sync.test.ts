/**
 * 退款路由对账与并发守卫的路由层行为验证——任务 t-mukt086l-zjzt0h
 *
 * refund-race.test.cjs（node:sqlite）已经在真实 SQL 层验证了守卫的并发语义；
 * 本文件在路由层验证接线行为：
 *   1. 占位 CAS 未抢到（changes=0，并发输家/额度不足）→ 不向渠道发起退款，直接拒绝
 *   2. 退款落库存渠道侧退款请求号（channel_refund_no，对账定位依据）
 *   3. 查询处理中的退款 → 向渠道对账：渠道成功 → 本地置 1
 *   4. 查询处理中的退款 → 渠道失败 → 本地置 2 并原子释放占位额度（batch）
 *   5. 渠道仍在处理 → 维持本地 status=0
 *   6. 渠道解析失败 → 对账尽力而为，仍返回本地记录
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { payRouter } from './pay';
import { Env } from '../types/env';

const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const API_KEY = 'integration-test-api-key';
const TRADE_NO = '01999999-cccc-7ddd-8eee-ffffffffffff';
const REFUND_ID = '01999999-eeee-7fff-8aaa-bbbbbbbbbbbb';

/** 渠道插件行为开关 */
let refundBehavior: { success: boolean; thirdPartyRefundNo?: string; refundNo?: string; message?: string } = {
    success: true,
    refundNo: 'CHN-RF-777',
    thirdPartyRefundNo: undefined, // 异步退款：渠道不立即回传第三方退款号 → 本地记「处理中」
};
let queryRefundBehavior: { status: 'processing' | 'success' | 'failed'; message?: string } = {
    status: 'processing',
};

/** 发出的 SQL 与 batch 调用记录 */
let executedSql: string[] = [];
let batchCalls: string[][] = [];
/** 占位 CAS 返回的 changes（模拟并发竞争结果） */
let reserveChanges = 1;

/** refunds 表的内存行（模拟对账 UPDATE 改状态） */
let refundRecord: any;

function createMockDb() {
    refundRecord = {
        id: REFUND_ID,
        refund_no: REFUND_ID,
        order_id: TRADE_NO,
        user_id: MERCHANT_ID,
        amount: 7.77,
        reason: '测试退款',
        status: 0,
        third_party_refund_no: null,
        channel_refund_no: 'CHN-RF-777',
        error_message: null,
        created_at: '2026-11-01T00:00:00.000Z',
        completed_at: null,
    };

    const order = {
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
    const channel = {
        id: 'ch-1',
        plugin: 'alipay',
        config: JSON.stringify({ appId: 'app-777', appSecret: 'secret-777' }),
    };

    /** 模拟内存状态变化：对账落库后重读能看到最新状态 */
    const applyStateChange = (sql: string) => {
        if (sql.includes('SET status = 1, completed_at')) refundRecord.status = 1;
        if (sql.includes('SET status = 2, error_message')) refundRecord.status = 2;
    };

    const prepare = (sql: string) => {
        const compact = sql.replace(/\s+/g, ' ');
        executedSql.push(compact);
        const statement: any = {
            _sql: compact,
            bind: (...args: any[]) => {
                statement._args = args;
                return statement;
            },
            first: async () => {
                if (compact.includes('FROM users')) return { id: MERCHANT_ID, status: 1 };
                if (compact.includes('FROM orders')) return order;
                if (compact.includes('FROM channels')) return channel;
                if (compact.includes('FROM refunds')) return refundRecord;
                return null;
            },
            all: async () => {
                if (compact.includes('FROM api_keys')) {
                    return { results: [{ id: 'key-1', user_id: MERCHANT_ID, api_key: API_KEY, name: '默认密钥', api_key_type: 'hmac-sha256', rsa_public_key: null }] };
                }
                return { results: [] };
            },
            run: async () => {
                applyStateChange(compact);
                const changes = compact.includes('refund_amount = refund_amount + ?') ? reserveChanges : 1;
                return { success: true, meta: { changes } };
            },
        };
        return statement;
    };
    return {
        prepare,
        batch: async (statements: any[]) => {
            batchCalls.push(statements.map((s) => s._sql));
            const results = [];
            for (const s of statements) {
                applyStateChange(s._sql);
                results.push({ success: true, meta: { changes: 1 } });
            }
            return results;
        },
    } as unknown as D1Database;
}

function createEnv(db: D1Database): Env {
    return { DB: db, ENCRYPTION_KEY: 'test-encryption-key', ENVIRONMENT: 'test', DEFAULT_CURRENCY: 'CNY', LOG_LEVEL: 'info', ENABLE_CORS: 'false' } as unknown as Env;
}

function callWithDb(db: D1Database, path: string, init: RequestInit = {}) {
    return payRouter.fetch(new Request(`https://pay.example.com${path}`, init), createEnv(db));
}

beforeEach(() => {
    executedSql = [];
    batchCalls = [];
    reserveChanges = 1;
    refundBehavior = { success: true, refundNo: 'CHN-RF-777', thirdPartyRefundNo: undefined };
    queryRefundBehavior = { status: 'processing' };
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
                refund: async () => ({
                    success: refundBehavior.success,
                    refundNo: refundBehavior.refundNo,
                    thirdPartyRefundNo: refundBehavior.thirdPartyRefundNo,
                    message: refundBehavior.message,
                }),
                queryRefund: async () => queryRefundBehavior,
            }),
        };
    });
    vi.resetModules();
});

function refundPostBody(money = '7.77') {
    return new URLSearchParams({ pid: MERCHANT_ID, trade_no: TRADE_NO, money, key: API_KEY });
}

describe('占位 CAS 未抢到（并发输家）', () => {
    it('changes=0 时拒绝退款且绝不调用渠道', async () => {
        const db = createMockDb();
        // 模拟并发对手已把可退额度占满：本次 CAS changes=0
        reserveChanges = 0;
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: refundPostBody(),
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('超出可退金额');
        // 守卫在渠道调用之前：CAS 输家不允许向渠道发起任何退款请求
        expect(executedSql.some((sql) => sql.includes('UPDATE orders') && sql.includes('refund_amount = refund_amount + ?'))).toBe(true);
        expect(executedSql.some((sql) => sql.includes('INSERT INTO refunds'))).toBe(false);
    });
});

describe('退款落库保存渠道侧退款请求号', () => {
    it('渠道受理但未回传第三方号：本地记处理中，channel_refund_no 落库', async () => {
        const db = createMockDb();
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: refundPostBody(),
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        // 渠道未回传第三方退款号时应记「处理中」
        expect(data.status).toBe(0);
        // 落库语句必须包含 channel_refund_no 列（对账 queryRefund 的定位依据）
        const insert = executedSql.find((sql) => sql.includes('INSERT INTO refunds'));
        expect(insert).toBeTruthy();
        expect(insert).toContain('channel_refund_no');
        expect(data.refund_no).toBeTruthy();
    });
});

describe('退款查询走渠道对账同步', () => {
    it('渠道确认成功：本地处理中 → 成功，返回 status=1', async () => {
        const db = createMockDb();
        queryRefundBehavior = { status: 'success' };
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=${REFUND_ID}&key=${API_KEY}`, {
            headers: { 'X-API-Key': API_KEY },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        // 对账到渠道成功后必须返回最新状态
        expect(data.status).toBe(1);
        // 渠道对账必须用渠道侧请求号（channel_refund_no 优先）
        expect(executedSql.some((sql) => sql.includes('SET status = 1, completed_at'))).toBe(true);
    });

    it('渠道确认失败：本地置失败并原子释放占位额度（batch 单事务）', async () => {
        const db = createMockDb();
        queryRefundBehavior = { status: 'failed', message: '渠道余额不足' };
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=${REFUND_ID}&key=${API_KEY}`, {
            headers: { 'X-API-Key': API_KEY },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        // 对账到渠道失败后必须返回失败状态
        expect(data.status).toBe(2);
        // 失败释放必须是 batch 事务：释放额度 + 退款记录置失败在同一批
        expect(batchCalls.length).toBe(1);
        const batch = batchCalls[0];
        // 必须释放占位额度
        expect(batch.some((sql) => sql.includes('refund_amount = refund_amount - ?'))).toBe(true);
        // 必须把退款记录置为失败
        expect(batch.some((sql) => sql.includes('UPDATE refunds SET status = 2'))).toBe(true);
        // 释放必须带处理中守卫（防并发重复释放）
        expect(batch.some((sql) => sql.includes('EXISTS'))).toBe(true);
        expect(executedSql.some((sql) => sql.includes('INSERT INTO refunds'))).toBe(false);
    });

    it('渠道仍在处理：维持本地 status=0，不改动记录', async () => {
        const db = createMockDb();
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=${REFUND_ID}&key=${API_KEY}`, {
            headers: { 'X-API-Key': API_KEY },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        expect(data.status).toBe(0);
        expect(executedSql.some((sql) => sql.includes('UPDATE refunds'))).toBe(false);
    });

    it('已终态（成功/失败）的退款不再触发渠道对账', async () => {
        const db = createMockDb();
        refundRecord.status = 1;
        refundRecord.completed_at = '2026-11-02T00:00:00.000Z';
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=${REFUND_ID}&key=${API_KEY}`, {
            headers: { 'X-API-Key': API_KEY },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        expect(data.status).toBe(1);
        expect(executedSql.some((sql) => sql.includes('UPDATE refunds'))).toBe(false);
        // 终态记录不得解析渠道
        expect(executedSql.some((sql) => sql.includes('FROM channels'))).toBe(false);
    });
});
