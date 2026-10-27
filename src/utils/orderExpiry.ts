/**
 * 未支付订单超时自动关闭
 *
 * 背景：status = 0 的订单不会自动过期，历史验证单会长期留在订单列表，
 * 并让 /api/pay/orders 的 count 变脏（任务 t-mvpyvjce-ikycno 实测 21 笔）。
 *
 * 安全前提（不能省）：
 *   notify.ts 的 handlePaymentSuccess 在 order.status !== 0 时直接返回 DUPLICATE
 *   并跳过入账。如果只按时间批量 UPDATE status = 3，渠道随后回调「已支付」时
 *   钱收了却不入账（吞钱）。因此关单前必须先向渠道 queryOrder 确认：
 *
 *     paid             → 走 creditOrder() 入账（与回调/轮询共用同一入账单元），绝不关单
 *     closed/refunded  → 已不可能再支付，关单
 *     pending          → 超过 TTL 视为废弃（主流渠道二维码 2h 内有效），关单
 *     查询异常/渠道缺失 → 本轮跳过，下一轮重试，绝不盲关
 *
 * TTL 来源：system_config.order_expire_minutes（管理后台可改）。
 *   - 未配置 / 非法值 → 默认 420 分钟（7h）
 *   - <= 0            → 关闭自动关单
 *   - 上限            → 43200 分钟（30 天）
 */

import { Env, OrderRow } from '../types/env';
import { getPlugin } from '../plugins';
import { decryptChannelConfig } from './crypto';
import { CREDIT_OUTCOME, CREDIT_SOURCE, creditOrder } from './credit';
import { logOrderEvent, logPaymentEvent } from './logging';

/** system_config 中的 TTL 配置键（0001_initial.sql 已种子，管理后台有输入框） */
export const ORDER_EXPIRY_CONFIG_KEY = 'order_expire_minutes';

export const ORDER_EXPIRY_DEFAULTS = {
    /** 未支付订单保留时长（分钟）：7h */
    ttlMinutes: 420,
    /** 每轮最多处理订单数，控制单次 Cron 的渠道调用量与执行时长 */
    batchSize: 177,
    /** TTL 上限（分钟）：30 天 */
    maxTtlMinutes: 43_200,
} as const;

export interface AutoCloseSummary {
    /** 本轮生效的 TTL（分钟），0 表示自动关单已禁用 */
    ttlMinutes: number;
    /** 本轮扫描到的超时未支付订单数 */
    scanned: number;
    /** 本轮成功关闭的订单数 */
    closed: number;
    /** 本轮渠道核对为已支付、转入入账的订单数 */
    credited: number;
    /** 本轮跳过（无法核对 / CAS 失败 / 已变更）的订单数 */
    skipped: number;
    /** 本轮处理异常数 */
    failed: number;
}

export interface AutoCloseOptions {
    /** 当前时间，测试可注入 */
    now?: Date;
    /** 单轮批量上限，测试可注入 */
    batchSize?: number;
}

/** 渠道核对结论 */
type ChannelVerdict = 'paid' | 'closeable' | 'unknown';

/**
 * 解析 TTL 配置值（纯函数，便于单测）
 */
export function resolveTtlMinutes(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') return ORDER_EXPIRY_DEFAULTS.ttlMinutes;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return ORDER_EXPIRY_DEFAULTS.ttlMinutes;
    if (parsed <= 0) return 0;
    return Math.min(Math.round(parsed), ORDER_EXPIRY_DEFAULTS.maxTtlMinutes);
}

async function readTtlMinutes(env: Env): Promise<number> {
    try {
        const row = (await env.DB.prepare(
            'SELECT value FROM system_config WHERE key = ?'
        )
            .bind(ORDER_EXPIRY_CONFIG_KEY)
            .first()) as { value?: string } | null;
        return resolveTtlMinutes(row?.value);
    } catch (error) {
        console.error('[OrderExpiry] 读取 order_expire_minutes 失败，使用默认值:', error);
        return ORDER_EXPIRY_DEFAULTS.ttlMinutes;
    }
}

/**
 * 向渠道核对订单：返回可关单、已支付（并完成入账）或无法判断。
 */
async function checkChannel(env: Env, order: OrderRow): Promise<ChannelVerdict> {
    if (!order.plugin || !order.channel_id) {
        // 没有渠道信息，无法核对；绝不盲关
        return 'unknown';
    }

    const channel = (await env.DB.prepare(
        'SELECT * FROM channels WHERE id = ?'
    )
        .bind(order.channel_id)
        .first()) as { config?: string } | null;

    if (!channel) {
        // 渠道记录已删除：无法向渠道核对，留给人工处理，不盲关
        console.error(`[OrderExpiry] 渠道记录缺失，跳过 order=${order.id} channel=${order.channel_id}`);
        return 'unknown';
    }

    try {
        const plugin = getPlugin(order.plugin);
        const channelConfig = await decryptChannelConfig(channel.config, env.ENCRYPTION_KEY);
        const status = await plugin.queryOrder(order.id, {
            ...channelConfig,
            appId: channelConfig.appId || '',
            appSecret: channelConfig.appSecret || '',
        });

        await logPaymentEvent(env, {
            orderId: order.id,
            userId: order.user_id,
            channelId: order.channel_id,
            plugin: order.plugin,
            direction: 'response',
            action: 'query_order',
            status: status.status === 'paid' ? 'success' : status.status,
            amount: order.amount,
            thirdPartyTradeNo: status.thirdPartyTradeNo || null,
            responseData: status,
        });

        if (status.status === 'paid') {
            // 与回调 / 轮询共用同一入账单元：金额核对 + status=0 CAS + 余额事务
            const credit = await creditOrder(
                env,
                order,
                {
                    tradeNo: order.id,
                    thirdPartyTradeNo: status.thirdPartyTradeNo,
                    buyer: status.buyer,
                    paidAt: status.paidAt,
                    paidAmount: status.paidAmount,
                },
                CREDIT_SOURCE.AUTO_EXPIRE
            );

            if (
                credit.outcome === CREDIT_OUTCOME.CREDITED ||
                credit.outcome === CREDIT_OUTCOME.DUPLICATE
            ) {
                return 'paid';
            }

            // 金额不符 / 数据库异常：钱在渠道那边，订单必须保留给人工对账
            console.error(
                `[OrderExpiry] 渠道已支付但入账未完成，保留订单待人工对账 order=${order.id} outcome=${credit.outcome} reason=${credit.reason || ''}`
            );
            return 'unknown';
        }

        // pending / closed / refunded：超过 TTL 都可关闭
        return 'closeable';
    } catch (error) {
        await logPaymentEvent(env, {
            orderId: order.id,
            userId: order.user_id,
            channelId: order.channel_id,
            plugin: order.plugin,
            direction: 'response',
            action: 'query_order',
            status: 'error',
            amount: order.amount,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.error(`[OrderExpiry] 渠道查询失败，本轮跳过 order=${order.id}:`, error);
        return 'unknown';
    }
}

/**
 * CAS 关单：只有 status 仍为 0 时才翻转，避免与回调 / 轮询竞态。
 * 返回 true 表示本次真正关单并写了 order_logs。
 */
async function closeOrderCas(
    env: Env,
    order: OrderRow,
    nowIso: string,
    ttlMinutes: number
): Promise<boolean> {
    const update = await env.DB.prepare(
        'UPDATE orders SET status = 3, closed_at = ? WHERE id = ? AND status = 0'
    )
        .bind(nowIso, order.id)
        .run();

    const changes = Number(update?.meta?.changes ?? 0);
    if (changes <= 0) {
        // 已被回调 / 轮询 / 人工关闭，保持原状态
        return false;
    }

    await logOrderEvent(env, {
        orderId: order.id,
        userId: order.user_id,
        outTradeNo: order.out_trade_no,
        action: 'closed',
        fromStatus: 0,
        toStatus: 3,
        amount: order.amount,
        detail: { source: 'auto_expire', ttl_minutes: ttlMinutes },
    });

    return true;
}

/**
 * 扫描并关闭超时未支付订单（Cron Trigger 调用）
 */
export async function autoCloseExpiredOrders(
    env: Env,
    options: AutoCloseOptions = {}
): Promise<AutoCloseSummary> {
    const now = options.now ?? new Date();
    const ttlMinutes = await readTtlMinutes(env);
    const summary: AutoCloseSummary = {
        ttlMinutes,
        scanned: 0,
        closed: 0,
        credited: 0,
        skipped: 0,
        failed: 0,
    };

    if (ttlMinutes <= 0) {
        // 0 / 负数 = 关闭自动关单
        return summary;
    }

    const limit = Math.min(
        Math.max(Math.floor(options.batchSize ?? ORDER_EXPIRY_DEFAULTS.batchSize), 1),
        1000
    );
    const cutoff = new Date(now.getTime() - ttlMinutes * 60_000).toISOString();

    const result = await env.DB.prepare(
        'SELECT * FROM orders WHERE status = 0 AND created_at < ? ORDER BY created_at ASC LIMIT ?'
    )
        .bind(cutoff, limit)
        .all<OrderRow>();

    const orders = (result.results || []) as OrderRow[];
    summary.scanned = orders.length;

    for (const order of orders) {
        try {
            if (order.plugin && order.channel_id) {
                const verdict = await checkChannel(env, order);
                if (verdict === 'paid') {
                    summary.credited += 1;
                    continue;
                }
                if (verdict === 'unknown') {
                    summary.skipped += 1;
                    continue;
                }
            }

            const closed = await closeOrderCas(env, order, now.toISOString(), ttlMinutes);
            if (closed) {
                summary.closed += 1;
            } else {
                summary.skipped += 1;
            }
        } catch (error) {
            summary.failed += 1;
            console.error(`[OrderExpiry] 处理订单失败 order=${order.id}:`, error);
        }
    }

    return summary;
}
