/**
 * 未支付订单超时自动关闭 —— 单元测试
 *
 * 锁定的核心行为：
 *   1. TTL 解析（默认 420 分钟 / 0 禁用 / 上限 30 天）
 *   2. 渠道已支付 → 走 creditOrder 入账，绝不关单
 *   3. 渠道未支付 → CAS 关单并写 order_logs（0 → 3）
 *   4. 渠道查询异常 / 渠道记录缺失 → 本轮跳过，绝不盲关
 *   5. CAS 未命中（已被回调或轮询处理）→ 不计入关闭
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getPlugin: vi.fn(),
    decryptChannelConfig: vi.fn(),
    creditOrder: vi.fn(),
}));

vi.mock('../plugins', () => ({ getPlugin: mocks.getPlugin }));
vi.mock('./crypto', () => ({ decryptChannelConfig: mocks.decryptChannelConfig }));
vi.mock('./credit', () => ({
    CREDIT_SOURCE: {
        CHANNEL_NOTIFY: 'channel_notify',
        STATUS_POLL: 'status_poll',
        AUTO_EXPIRE: 'auto_expire',
    },
    CREDIT_OUTCOME: {
        CREDITED: 'credited',
        DUPLICATE: 'duplicate',
        AMOUNT_MISMATCH: 'amount_mismatch',
        DB_ERROR: 'db_error',
        NOT_FOUND: 'not_found',
    },
    creditOrder: mocks.creditOrder,
}));

import { autoCloseExpiredOrders, resolveTtlMinutes } from './orderExpiry';
import type { Env } from '../types/env';

interface FakeDbState {
    config?: Record<string, string>;
    orders: any[];
    channels?: Record<string, any>;
    /** UPDATE 返回的 meta.changes，默认 1 */
    updateChanges?: number;
}

function createEnv(state: FakeDbState) {
    const updates: Array<{ sql: string; args: any[] }> = [];
    const selects: Array<{ sql: string; args: any[] }> = [];
    const inserts: string[] = [];

    const prepare = (sql: string) => {
        let bound: any[] = [];
        const stmt: any = {
            bind: (...args: any[]) => {
                bound = args;
                return stmt;
            },
            first: async () => {
                if (sql.includes('FROM system_config')) {
                    const key = String(bound[0]);
                    return state.config && key in state.config ? { value: state.config[key] } : null;
                }
                if (sql.includes('FROM channels')) {
                    return state.channels?.[String(bound[0])] ?? null;
                }
                return null;
            },
            all: async () => {
                selects.push({ sql, args: bound });
                return { results: state.orders };
            },
            run: async () => {
                if (sql.trim().startsWith('UPDATE orders')) {
                    updates.push({ sql, args: bound });
                    return { meta: { changes: state.updateChanges ?? 1 } };
                }
                if (sql.includes('INSERT INTO order_logs')) inserts.push('order_logs');
                if (sql.includes('INSERT INTO payment_logs')) inserts.push('payment_logs');
                return { meta: { changes: 1 } };
            },
        };
        return stmt;
    };

    const env = { DB: { prepare }, ENCRYPTION_KEY: 'test-key' } as unknown as Env;
    return { env, updates, selects, inserts };
}

function unpaidOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 'order-1',
        user_id: 'merchant-1',
        out_trade_no: 'CASHIER1',
        plugin: 'xunhupay',
        channel_id: 'ch-1',
        amount: 0.01,
        status: 0,
        created_at: '2026-06-28T08:51:07.588Z',
        ...overrides,
    };
}

const NOW = new Date('2026-10-27T01:00:00.000Z');

beforeEach(() => {
    mocks.getPlugin.mockReset();
    mocks.decryptChannelConfig.mockReset();
    mocks.creditOrder.mockReset();
    mocks.getPlugin.mockReturnValue({ queryOrder: vi.fn(async () => ({ status: 'pending' })) });
    mocks.decryptChannelConfig.mockResolvedValue({});
    mocks.creditOrder.mockResolvedValue({ outcome: 'credited' });
});

describe('resolveTtlMinutes', () => {
    it('未配置 / 非法值回退默认 420 分钟', () => {
        expect(resolveTtlMinutes(undefined)).toBe(420);
        expect(resolveTtlMinutes(null)).toBe(420);
        expect(resolveTtlMinutes('')).toBe(420);
        expect(resolveTtlMinutes('abc')).toBe(420);
    });

    it('0 与负数表示禁用自动关单', () => {
        expect(resolveTtlMinutes('0')).toBe(0);
        expect(resolveTtlMinutes(-1)).toBe(0);
    });

    it('正常值透传并对上限封顶 30 天', () => {
        expect(resolveTtlMinutes('420')).toBe(420);
        expect(resolveTtlMinutes('7')).toBe(7);
        expect(resolveTtlMinutes('999999')).toBe(43_200);
    });
});

describe('autoCloseExpiredOrders', () => {
    it('配置为 0 时直接跳过，不查询订单', async () => {
        const { env, selects } = createEnv({
            config: { order_expire_minutes: '0' },
            orders: [unpaidOrder()],
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.ttlMinutes).toBe(0);
        expect(summary.scanned).toBe(0);
        expect(selects).toHaveLength(0);
    });

    it('渠道路径：已支付 → 入账，绝不关单', async () => {
        mocks.getPlugin.mockReturnValue({
            queryOrder: vi.fn(async () => ({ status: 'paid', paidAmount: 0.01 })),
        });
        const { env, updates } = createEnv({
            orders: [unpaidOrder()],
            channels: { 'ch-1': { config: '{}' } },
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.credited).toBe(1);
        expect(summary.closed).toBe(0);
        expect(mocks.creditOrder).toHaveBeenCalledTimes(1);
        expect(updates).toHaveLength(0);
    });

    it('渠道已支付但入账被拒（金额不符）→ 保留订单待人工对账', async () => {
        mocks.getPlugin.mockReturnValue({
            queryOrder: vi.fn(async () => ({ status: 'paid', paidAmount: 9.99 })),
        });
        mocks.creditOrder.mockResolvedValue({ outcome: 'amount_mismatch', reason: '金额不符' });
        const { env, updates } = createEnv({
            orders: [unpaidOrder()],
            channels: { 'ch-1': { config: '{}' } },
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.skipped).toBe(1);
        expect(summary.closed).toBe(0);
        expect(updates).toHaveLength(0);
    });

    it('渠道未支付 → CAS 关单并写 order_logs', async () => {
        const { env, updates, inserts } = createEnv({
            orders: [unpaidOrder()],
            channels: { 'ch-1': { config: '{}' } },
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.closed).toBe(1);
        expect(updates).toHaveLength(1);
        expect(updates[0].args[1]).toBe('order-1');
        expect(inserts).toContain('order_logs');
    });

    it('渠道查询异常 → 本轮跳过，不关单', async () => {
        mocks.getPlugin.mockReturnValue({
            queryOrder: vi.fn(async () => {
                throw new Error('network down');
            }),
        });
        const { env, updates } = createEnv({
            orders: [unpaidOrder()],
            channels: { 'ch-1': { config: '{}' } },
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.skipped).toBe(1);
        expect(summary.closed).toBe(0);
        expect(updates).toHaveLength(0);
    });

    it('渠道记录缺失 → 跳过（不盲关）', async () => {
        const { env, updates } = createEnv({ orders: [unpaidOrder()] });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.skipped).toBe(1);
        expect(updates).toHaveLength(0);
    });

    it('无渠道信息的订单 → 直接关单', async () => {
        const { env, updates } = createEnv({
            orders: [unpaidOrder({ plugin: null, channel_id: null })],
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.closed).toBe(1);
        expect(updates).toHaveLength(1);
    });

    it('CAS 未命中（已被回调/轮询处理）→ 不计入关闭且不写日志', async () => {
        const { env, inserts } = createEnv({
            orders: [unpaidOrder({ plugin: null, channel_id: null })],
            updateChanges: 0,
        });

        const summary = await autoCloseExpiredOrders(env, { now: NOW });

        expect(summary.closed).toBe(0);
        expect(summary.skipped).toBe(1);
        expect(inserts).not.toContain('order_logs');
    });

    it('cutoff 按 TTL 计算，批量上限传入 SQL', async () => {
        const { env, selects } = createEnv({
            config: { order_expire_minutes: '420' },
            orders: [],
        });

        await autoCloseExpiredOrders(env, { now: NOW, batchSize: 50 });

        const expectedCutoff = new Date(NOW.getTime() - 420 * 60_000).toISOString();
        expect(selects).toHaveLength(1);
        expect(selects[0].args[0]).toBe(expectedCutoff);
        expect(selects[0].args[1]).toBe(50);
    });
});
