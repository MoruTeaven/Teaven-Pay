/**
 * 退款额度守卫（资金安全）
 *
 * 退款资金安全的唯一权威是这里的 SQL 守卫，应用层的余额预检只是友好提示：
 *  - reserveRefundQuota：CAS 占位——refund_amount + 退款额 <= 订单额且订单仍为已支付(status=1)，
 *    只有抢到这次 UPDATE（meta.changes > 0）的请求才能继续发起渠道退款；
 *    并发退款 / 重复请求在数据库层被拒绝，绝不会超退。
 *  - releaseRefundQuota：渠道退款失败后，在单个 D1 batch（单事务）里释放占位额度并回翻订单状态，
 *    要么同时生效要么都不生效，不留「占位悬空」状态。
 *  - settleRefundSuccess / settleRefundFailed：退款对账（渠道查询同步）的结果落库。
 *    失败分支的「释放额度」带 EXISTS(status=0) 守卫——释放只允许发生在退款记录
 *    仍处于「处理中」时，两个并发对账请求不会把同一笔占位释放两次（防超退）。
 *
 * 金额一律按「分」做整数比较（与 credit.ts 的按分核对同一思路）：
 * REAL 列直接比较存在浮点误差（如 66.66 + 11.11 会得到 77.77000000000001），
 * 可能把合法的全额退款误拒，甚至（更糟的）把超退放行。CAST(ROUND(x*100) AS INTEGER) 消除误差。
 */

/**
 * 占位守卫：CAS 累加 refund_amount。
 * 守卫条件：订单仍为已支付(status=1)，且按分比较「已退 + 本次 <= 订单额」。
 */
export const REFUND_RESERVE_SQL = `
    UPDATE orders
       SET refund_amount = refund_amount + ?
     WHERE id = ? AND status = 1
       AND CAST(ROUND(refund_amount * 100) AS INTEGER) + CAST(ROUND(? * 100) AS INTEGER)
           <= CAST(ROUND(amount * 100) AS INTEGER)
`;

/**
 * 释放占位额度：refund_amount 回退。
 * 额度充足性检查同样按分整数比较——REAL 累加后的 refund_amount 是 77.76999999999998
 * 这类带噪声的值，裸浮点比较 `refund_amount >= 77.77` 会判假，导致释放静默失败
 * （占位永久悬空），按分后 7777 >= 7777 恒成立。
 */
export const REFUND_RELEASE_SQL = `
    UPDATE orders
       SET refund_amount = refund_amount - ?
     WHERE id = ?
       AND CAST(ROUND(refund_amount * 100) AS INTEGER) >= CAST(ROUND(? * 100) AS INTEGER)
`;

/**
 * 订单状态回翻：释放后仍有可退余额时，把「已退款」回到「已支付」。
 *
 * 条件必须是「还有可退余额」而不是「额度归零」：部分退款场景下（此前已有成功的部分退款，
 * 本次全额占位后渠道失败），释放后 refund_amount 大于 0 但小于订单额，
 * 若只认「归零才回翻」，订单会永远卡在已退款状态，剩余额度再也退不出去。
 * 比较按分整数，理由同上。
 */
export const REFUND_RELEASE_STATUS_SQL = `
    UPDATE orders
       SET status = 1
     WHERE id = ? AND status = 2
       AND CAST(ROUND(refund_amount * 100) AS INTEGER) < CAST(ROUND(amount * 100) AS INTEGER)
`;

/**
 * 对账失败释放占位额度：仅当退款记录仍处于「处理中」(status=0) 时才释放。
 *
 * 这条 EXISTS 守卫是对账并发安全的关键：batch 内先执行本句、再 CAS 翻转退款记录，
 * 并发的第二个对账请求进来时 refunds 已被置为失败（status=2），EXISTS 不成立，
 * 因此不会重复释放同一笔占位（重复释放 = 凭空多出可退额度 = 超退漏洞）。
 * 额度充足性按分比较，理由同上。
 */
export const REFUND_SYNC_RELEASE_SQL = `
    UPDATE orders
       SET refund_amount = refund_amount - ?
     WHERE id = ?
       AND CAST(ROUND(refund_amount * 100) AS INTEGER) >= CAST(ROUND(? * 100) AS INTEGER)
       AND EXISTS (SELECT 1 FROM refunds WHERE id = ? AND status = 0)
`;

/** 对账结果落库：退款记录 CAS 置为失败（仅处理中 → 失败，防并发重复落账） */
export const REFUND_SYNC_MARK_FAILED_SQL = `
    UPDATE refunds
       SET status = 2, error_message = ?
     WHERE id = ? AND status = 0
`;

/** 对账结果落库：退款记录 CAS 置为成功并记录完成时间（仅处理中 → 成功） */
export const REFUND_SYNC_MARK_SUCCESS_SQL = `
    UPDATE refunds
       SET status = 1, completed_at = ?
     WHERE id = ? AND status = 0
`;

/** 金额统一按「分」，与守卫 SQL 的 CAST(ROUND(x*100)) 口径一致 */
export function refundToCents(value: number): number {
    return Math.round(value * 100);
}

/**
 * 占住退款额度（CAS）：返回 true 表示本次抢到占位，可以继续向渠道发起退款。
 * 返回 false 表示订单状态已变更或可退额度不足（含并发对手已把额度占满），必须拒绝。
 */
export async function reserveRefundQuota(
    db: D1Database,
    orderId: string,
    amount: number
): Promise<boolean> {
    const result = await db.prepare(REFUND_RESERVE_SQL).bind(amount, orderId, amount).run();
    return (result?.meta?.changes ?? 0) > 0;
}

/**
 * 渠道退款失败后释放占位（发起退款路径）：
 * 额度释放与状态回翻在同一个 D1 batch（单事务）里原子生效。
 * 事务失败只记日志留痕（此时存在「占位未释放」的悬空状态，需人工对账），
 * 不向上抛——调用方的失败响应不因回滚自身的数据库故障而变成 500。
 */
export async function releaseRefundQuota(
    db: D1Database,
    orderId: string,
    amount: number
): Promise<void> {
    try {
        await db.batch([
            db.prepare(REFUND_RELEASE_SQL).bind(amount, orderId, amount),
            db.prepare(REFUND_RELEASE_STATUS_SQL).bind(orderId),
        ]);
    } catch (error) {
        console.error(
            `[refundGuard] 退款占位释放失败，需人工对账 order=${orderId} amount=${amount}:`,
            error
        );
    }
}

/**
 * 渠道对账确认成功：退款记录「处理中 → 成功」（CAS），完成时间取渠道对账时刻。
 * 返回 true 表示本次生效；false 表示记录已被并发对账处理过。
 */
export async function settleRefundSuccess(
    db: D1Database,
    refundId: string
): Promise<boolean> {
    const result = await db
        .prepare(REFUND_SYNC_MARK_SUCCESS_SQL)
        .bind(new Date().toISOString(), refundId)
        .run();
    return (result?.meta?.changes ?? 0) > 0;
}

/**
 * 渠道对账确认失败：钱没有退出去，必须把占位额度还回去，否则可退额度永久丢失。
 *
 * batch（单事务）内语句顺序即并发安全设计：
 *  1. 释放占位额度——EXISTS(refunds.status=0) 守卫，只有记录还在「处理中」才释放；
 *  2. 退款记录 CAS「处理中 → 失败」；
 *  3. 订单状态回翻（仍有可退余额时 2 → 1）。
 * 并发的第二个对账请求：步骤 1 的 EXISTS 不成立（记录已被第一个事务置为失败），
 * 步骤 2 的 CAS changes=0，同一笔占位绝不会释放两次。
 */
export async function settleRefundFailed(
    db: D1Database,
    refundId: string,
    orderId: string,
    amount: number,
    errorMessage: string
): Promise<{ released: boolean; marked: boolean }> {
    try {
        const results = await db.batch([
            db.prepare(REFUND_SYNC_RELEASE_SQL).bind(amount, orderId, amount, refundId),
            db.prepare(REFUND_SYNC_MARK_FAILED_SQL).bind(errorMessage, refundId),
            db.prepare(REFUND_RELEASE_STATUS_SQL).bind(orderId),
        ]);

        const released = (results?.[0]?.meta?.changes ?? 0) > 0;
        const marked = (results?.[1]?.meta?.changes ?? 0) > 0;

        // 记录被置为失败但额度没有释放 = 可退额度凭空少了一笔，必须留痕人工对账。
        // 正常数据下两者同生同死（占位时的累加保证额度一定充足）；
        // 出现该组合说明库内数据已经异常，靠日志把问题暴露出来。
        if (marked && !released) {
            console.error(
                `[refundGuard] 对账置失败但占位额度未释放（悬空），需人工对账 refund=${refundId} order=${orderId} amount=${amount}`
            );
        }

        return { released, marked };
    } catch (error) {
        console.error(
            `[refundGuard] 对账失败落库事务异常 refund=${refundId} order=${orderId}:`,
            error
        );
        return { released: false, marked: false };
    }
}
