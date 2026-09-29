/**
 * 订单入账核心（资金安全）
 *
 * 修复的三个问题（原实现在 notify.ts / pay.ts 中各写一份）：
 *  1. notify 路径：SELECT(WHERE status=0) -> UPDATE(无守卫) -> 无条件 balance += profit，
 *     SELECT 与 UPDATE 之间存在竞态窗口，并发回调 / 回调+轮询交错会双倍入账。
 *  2. status 轮询路径：UPDATE 有 AND status=0 守卫，但不看 meta.changes 就加余额，
 *     订单已被别人翻转时（changes=0）余额仍被加。
 *  3. 两条路径都只用订单金额，从不与渠道回调的实付金额比对，
 *     易支付类渠道允许改价时付 0.01 也能让全额订单记为已支付。
 *
 * 现在统一的不变式：
 *  - 先做金额核对（容差 0），不一致直接拒绝入账并记日志；
 *  - 用带 AND status=0 守卫的 UPDATE 做「状态翻转 CAS」，只有 meta.changes>0 的那一次才继续；
 *  - 余额、统计、审计流水放在同一个 D1 batch（单事务）里，保证要么全成要么全无；
 *  - 入账失败会把订单回退为未支付（只回退自己刚翻转的那次），让渠道重试而不是丢单。
 */

import { Env, OrderRow } from '../types/env';
import { buildOrderLogStatement, buildPaymentLogStatement } from './logging';
import { generateUUIDv7 } from './uuid';

/** 入账来源 */
export const CREDIT_SOURCE = {
    CHANNEL_NOTIFY: 'channel_notify',
    STATUS_POLL: 'status_poll',
} as const;
export type CreditSource = (typeof CREDIT_SOURCE)[keyof typeof CREDIT_SOURCE];

/** 入账结果 */
export const CREDIT_OUTCOME = {
    /** 本次抢到状态翻转并完成入账 */
    CREDITED: 'credited',
    /** 订单已被其它请求/其它路径入账，本次未触碰余额 */
    DUPLICATE: 'duplicate',
    /** 回调金额与订单金额不一致（或渠道未给出金额），拒绝入账 */
    AMOUNT_MISMATCH: 'amount_mismatch',
    /** 数据库异常，事务已回滚，未入账 */
    DB_ERROR: 'db_error',
    /** 订单不存在 */
    NOT_FOUND: 'not_found',
} as const;
export type CreditOutcome = (typeof CREDIT_OUTCOME)[keyof typeof CREDIT_OUTCOME];

/** 渠道回传的支付信息 */
export interface CreditParams {
    /** 平台订单号（orders.id） */
    tradeNo: string;
    /** 第三方交易号 */
    thirdPartyTradeNo?: string;
    /** 买家标识 */
    buyer?: string;
    /** 支付时间 ISO 字符串 */
    paidAt?: string;
    /** 渠道实付金额（元）；undefined/null 表示渠道未提供 */
    paidAmount?: number | null;
}

export interface CreditResult {
    outcome: CreditOutcome;
    /** 本次入账的净额（元），仅 CREDITED 有值 */
    profit?: number;
    /** 拒绝/失败原因，便于日志与排查 */
    reason?: string;
}

/** 金额统一按「分」比较，避免浮点误差；容差 0 */
function toCents(value: number): number {
    return Math.round(value * 100);
}

/**
 * 回调金额核对：实付金额必须与订单金额一分不差
 */
export function matchOrderAmount(
    orderAmount: number,
    paidAmount: number | null | undefined
): { ok: boolean; reason?: string; expectedCents?: number; paidCents?: number } {
    const expectedCents = toCents(Number(orderAmount));
    if (!Number.isFinite(expectedCents)) {
        return { ok: false, reason: `订单金额不合法: ${orderAmount}` };
    }
    if (paidAmount === undefined || paidAmount === null) {
        // 渠道没给实付金额就无法核对，资金安全优先，拒绝入账
        return { ok: false, reason: '回调未提供实付金额，无法核对', expectedCents };
    }
    const paid = Number(paidAmount);
    if (!Number.isFinite(paid) || paid <= 0) {
        return { ok: false, reason: `回调实付金额不合法: ${paidAmount}`, expectedCents };
    }
    const paidCents = toCents(paid);
    if (paidCents !== expectedCents) {
        return {
            ok: false,
            reason: `金额不一致：订单 ${expectedCents} 分，实付 ${paidCents} 分，差额 ${expectedCents - paidCents} 分`,
            expectedCents,
            paidCents,
        };
    }
    return { ok: true, expectedCents, paidCents };
}

/**
 * 幂等入账：金额核对 -> 状态翻转 CAS -> 单事务批量入账
 *
 * 调用方约定：order 为「入账前快照」，本函数内部会再次以守卫 SQL 校验状态，
 * 因此即使调用方读到的快照已经过期，也不会重复入账。
 */
export async function creditOrder(
    env: Env,
    order: OrderRow,
    params: CreditParams,
    source: CreditSource,
    logMeta?: { ip?: string | null; userAgent?: string | null }
): Promise<CreditResult> {
    const orderId = params.tradeNo || order.id;

    // ===== 1. 回调金额核对（DoD 3）=====
    const amountCheck = matchOrderAmount(order.amount, params.paidAmount);
    if (!amountCheck.ok) {
        const reason = amountCheck.reason || '金额核对失败';
        console.error(`[Credit/${source}] 拒绝入账 ${orderId}: ${reason}`);
        await Promise.all([
            buildOrderLogStatement(env, {
                orderId,
                userId: order.user_id,
                outTradeNo: order.out_trade_no,
                action: 'credit_rejected',
                fromStatus: order.status,
                toStatus: order.status,
                amount: order.amount,
                detail: {
                    source,
                    reason,
                    expected_cents: amountCheck.expectedCents ?? null,
                    paid_cents: amountCheck.paidCents ?? null,
                    paid_amount: params.paidAmount ?? null,
                },
                ...(logMeta || {})
            }).run(),
            buildPaymentLogStatement(env, {
                orderId,
                userId: order.user_id,
                channelId: order.channel_id,
                plugin: order.plugin,
                direction: 'internal',
                action: `${source}_amount_verify`,
                status: 'rejected',
                amount: order.amount,
                thirdPartyTradeNo: params.thirdPartyTradeNo || null,
                responseData: {
                    order_amount: order.amount,
                    paid_amount: params.paidAmount ?? null,
                    expected_cents: amountCheck.expectedCents ?? null,
                    paid_cents: amountCheck.paidCents ?? null,
                },
                errorMessage: reason,
            }).run(),
        ]).catch(async (error) => {
            console.error(`[Credit/${source}] 金额不一致日志写入失败:`, error);
        });
        return { outcome: CREDIT_OUTCOME.AMOUNT_MISMATCH, reason };
    }

    const paidAt = params.paidAt || new Date().toISOString();
    const paidAmountCents = amountCheck.paidCents as number;
    const paidAmount = paidAmountCents / 100;

    // ===== 2. 状态翻转 CAS：只有把 0 改成 1 的那次才允许入账（DoD 1）=====
    let flip: D1Result | null = null;
    try {
        flip = await env.DB.prepare(
            `UPDATE orders
                SET status = 1,
                    api_trade_no = ?,
                    buyer = ?,
                    paid_at = ?,
                    actual_amount = ?,
                    notify_status = 0
                WHERE id = ? AND status = 0`
        )
            .bind(params.thirdPartyTradeNo || '', params.buyer || '', paidAt, paidAmount, orderId)
            .run();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[Credit/${source}] 订单状态翻转失败 ${orderId}:`, error);
        await logPaymentFailure(env, order, source, params, `状态翻转失败: ${reason}`, logMeta);
        return { outcome: CREDIT_OUTCOME.DB_ERROR, reason };
    }

    const changes = flip?.meta?.changes ?? 0;
    if (changes <= 0) {
        // 守卫没命中：订单已被并发请求/轮询路径/人工操作入账，本次绝不加钱
        console.log(`[Credit/${source}] 重复回调，跳过入账: ${orderId}`);
        await logPaymentFailure(
            env,
            order,
            source,
            params,
            '重复回调：订单状态已被其它请求翻转，本次未入账',
            logMeta,
            'duplicate'
        );
        return { outcome: CREDIT_OUTCOME.DUPLICATE, reason: '订单已入账（重复回调）' };
    }

    // ===== 3. 入账：余额 + 统计 + 审计流水，单个 D1 事务（DoD 2、4）=====
    const fee = order.fee || 0;
    const profit = order.amount - fee;

    try {
        const batchResults = await env.DB.batch([
            env.DB.prepare(
                `UPDATE users
                    SET balance = balance + ?,
                        today_income = today_income + ?,
                        total_income = total_income + ?,
                        today_orders = today_orders + 1,
                        total_orders = total_orders + 1
                    WHERE id = ?`
            ).bind(profit, profit, profit, order.user_id),
            buildOrderLogStatement(env, {
                orderId,
                userId: order.user_id,
                outTradeNo: order.out_trade_no,
                action: 'paid',
                fromStatus: 0,
                toStatus: 1,
                amount: order.amount,
                detail: {
                    source,
                    profit,
                    fee,
                    paid_amount: paidAmount,
                    third_party_trade_no: params.thirdPartyTradeNo || '',
                },
                ...(logMeta || {})
            }),
            buildPaymentLogStatement(env, {
                orderId,
                userId: order.user_id,
                channelId: order.channel_id,
                plugin: order.plugin,
                direction: 'internal',
                action: `${source}_credit`,
                status: 'success',
                amount: order.amount,
                thirdPartyTradeNo: params.thirdPartyTradeNo || null,
                responseData: {
                    profit,
                    fee,
                    paid_amount: paidAmount,
                    paid_at: paidAt,
                    buyer: params.buyer || '',
                    credit_id: generateUUIDv7(),
                },
            }),
        ]);

        // 防御：余额语句必须真的命中商户行，否则宁可回滚，绝不能出现
        // 「订单已支付但余额没加」的静默丢账
        const creditChanges = batchResults?.[0]?.meta?.changes ?? 0;
        if (creditChanges <= 0) {
            const reason = `入账未命中商户行（user_id=${order.user_id} 可能不存在），已回滚`;
            console.error(`[Credit/${source}] ${reason}: ${orderId}`);
            try {
                await env.DB.prepare(
                    "UPDATE orders SET status = 0, paid_at = NULL WHERE id = ? AND status = 1 AND paid_at = ?"
                ).bind(orderId, paidAt).run();
            } catch (rollbackError) {
                console.error(`[Credit/${source}] 订单状态回退失败 ${orderId}，需人工对账:`, rollbackError);
            }
            await logPaymentFailure(env, order, source, params, reason, logMeta);
            return { outcome: CREDIT_OUTCOME.DB_ERROR, reason };
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[Credit/${source}] 入账事务失败 ${orderId}，回退订单状态以便重试:`, error);

        // 回退刚才的翻转，避免「已支付但未入账」的悬空状态（只回退自己这次写的 paid_at）
        try {
            await env.DB.prepare(
                "UPDATE orders SET status = 0, api_trade_no = COALESCE(api_trade_no, ''), paid_at = NULL WHERE id = ? AND status = 1 AND paid_at = ?"
            )
                .bind(orderId, paidAt)
                .run();
        } catch (rollbackError) {
            console.error(`[Credit/${source}] 订单状态回退失败 ${orderId}，需人工对账:`, rollbackError);
        }

        await logPaymentFailure(env, order, source, params, `入账事务失败: ${reason}`, logMeta);
        return { outcome: CREDIT_OUTCOME.DB_ERROR, reason };
    }

    console.log(`[Credit/${source}] 入账成功 ${orderId}: profit=${profit.toFixed(2)}`);
    return { outcome: CREDIT_OUTCOME.CREDITED, profit };
}

/** 失败/重复场景的支付流水日志（best-effort，不影响资金结果） */
async function logPaymentFailure(
    env: Env,
    order: OrderRow,
    source: CreditSource,
    params: CreditParams,
    errorMessage: string,
    logMeta?: { ip?: string | null; userAgent?: string | null },
    status: string = 'failed'
): Promise<void> {
    try {
        await buildPaymentLogStatement(env, {
            orderId: params.tradeNo || order.id,
            userId: order.user_id,
            channelId: order.channel_id,
            plugin: order.plugin,
            direction: 'internal',
            action: `${source}_credit`,
            status,
            amount: order.amount,
            thirdPartyTradeNo: params.thirdPartyTradeNo || null,
            responseData: {
                source,
                paid_amount: params.paidAmount ?? null,
                ip: logMeta?.ip ?? null,
                user_agent: logMeta?.userAgent ?? null,
            },
            errorMessage,
        }).run();
    } catch (error) {
        console.error(`[Credit/${source}] 失败流水写入异常:`, error);
    }
}