-- 展示名统一为「支付宝」：用户无需感知 AI / 网页收款等内部产品形态。
-- 支付方式为单一 pt_alipay（0011 已直接复用它，不再新建重复支付方式）；
-- 本迁移对新库是空操作，对早期执行过旧版 0011（曾创建 pt_alipay_web）的库做纠正。

UPDATE payment_types
SET display_name = '支付宝',
    status = 1,
    updated_at = datetime('now')
WHERE id = 'pt_alipay';

UPDATE channels
SET name = '支付宝网页收款',
    description = 'alipay.trade.page.pay；请在后台配置 appId/privateKey(PKCS#1)/alipayPublicKey/notifyUrl/returnUrl',
    updated_at = datetime('now')
WHERE id = 'ch_alipay_web';
