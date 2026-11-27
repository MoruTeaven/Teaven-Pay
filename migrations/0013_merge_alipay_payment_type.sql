-- 支付方式合并：网页收款复用原有「支付宝」支付方式（pt_alipay），不再保留第二个。
-- 插件（alipay_web）与通道（ch_alipay_web）均保留不动，只调整 payment_types 归属与订单关联。

-- 1) 网页收款通道改挂到原「支付宝」支付方式下（插件仍是 alipay_web）
UPDATE channels
SET payment_type_id = 'pt_alipay',
    updated_at = datetime('now')
WHERE id = 'ch_alipay_web';

-- 2) 原有「支付宝」支付方式启用，作为唯一对外支付方式
UPDATE payment_types
SET status = 1,
    display_name = '支付宝',
    sort_order = 1,
    updated_at = datetime('now')
WHERE id = 'pt_alipay';

-- 3) 历史订单的支付方式归并到 pt_alipay（展示与查询保持一致）
UPDATE orders SET payment_type = 'pt_alipay' WHERE payment_type = 'pt_alipay_web';

-- 4) 删除重复的支付方式（历史订单已在第 3 步归并，无残留引用）
DELETE FROM payment_types WHERE id = 'pt_alipay_web';
