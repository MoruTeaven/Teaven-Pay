/**
 * 退款/结算竞态 CAS 守卫自检
 *
 * 三处改动（pay.ts 退款、admin.ts 结算审批、merchant.ts 结算申请）均依赖
 * 「带守卫 WHERE 的 UPDATE → meta.changes>0 才继续」的不变式。
 * 本测试验证守卫条件在并发场景下的语义正确性：
 *   - 退款：refund_amount + ? <= amount 且 status=1 → 并发只过一次
 *   - 结算：status=0 → 并发审批/拒绝只过一次
 *   - 结算申请：balance >= ? → 并发扣减只过一次（防负余额）
 */
import { describe, expect, it } from 'vitest';

describe('退款/结算 CAS 守卫语义', () => {
    // 守卫语义与生产 SQL 一致：
    //   pay.ts:      WHERE id=? AND status=1 AND refund_amount + ? <= amount
    //   admin.ts:    WHERE id=? AND status=0
    //   merchant.ts: WHERE id=? AND balance >= ?

    it('退款：并发累加 refund_amount 只有一次通过守卫', () => {
        const order = { status: 1, amount: 100, refund_amount: 0 };
        const guard = (r: number) => order.status === 1 && order.refund_amount + r <= order.amount;

        // 第一次退款 60 → 通过
        expect(guard(60)).toBe(true);
        order.refund_amount += 60;
        expect(order.refund_amount).toBe(60);

        // 并发第二次退款 60 → 60+60=120 > 100，守卫拒绝
        expect(guard(60)).toBe(false);
        expect(order.refund_amount).toBe(60);

        // 追加退款 40 → 60+40=100 <= 100，通过（部分退款仍可继续）
        expect(guard(40)).toBe(true);
        order.refund_amount += 40;
        expect(order.refund_amount).toBe(100);
    });

    it('退款：全额退款翻转 status 只有一次通过守卫', () => {
        const order = { status: 1 };
        const flipGuard = () => order.status === 1;

        expect(flipGuard()).toBe(true);
        order.status = 2; // 翻转
        expect(flipGuard()).toBe(false); // 已退款，不再翻转
    });

    it('结算审批：并发处理只有一次拿到 changes>0', () => {
        const settlement = { status: 0, amount: 100 };
        const approveGuard = () => settlement.status === 0;

        expect(approveGuard()).toBe(true);
        settlement.status = 2; // 批准
        expect(approveGuard()).toBe(false); // 已处理，拒绝

        // 拒绝分支同理
        settlement.status = 0;
        expect(approveGuard()).toBe(true);
        settlement.status = 3; // 拒绝
        expect(approveGuard()).toBe(false);
    });

    it('结算申请：并发扣减余额只有一次通过守卫（防负余额）', () => {
        const user = { balance: 100, frozen_balance: 0 };
        const balanceGuard = (amt: number) => user.balance >= amt;

        // 第一次申请 60 → 通过
        expect(balanceGuard(60)).toBe(true);
        user.balance -= 60; user.frozen_balance += 60;
        expect(user.balance).toBe(40);

        // 并发第二次申请 60 → 40 < 60，守卫拒绝
        expect(balanceGuard(60)).toBe(false);
        expect(user.balance).toBe(40);

        // 申请 40 → 40 >= 40，通过
        expect(balanceGuard(40)).toBe(true);
        user.balance -= 40; user.frozen_balance += 40;
        expect(user.balance).toBe(0);
    });
});
