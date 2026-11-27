-- 前台展示名统一为「支付宝」：用户无需感知 AI / 网页收款等内部产品形态。
-- 修正已执行过 0011 的库（新环境 0011 已是「支付宝」，本迁移重复执行安全）。

UPDATE payment_types
SET display_name = '支付宝',
    description = '支付宝网页收款（电脑网页/手机 H5）',
    updated_at = datetime('now')
WHERE id = 'pt_alipay_web';

UPDATE channels
SET name = '支付宝网页收款',
    description = 'alipay.trade.page.pay；请在后台配置 appId/privateKey(PKCS#1)/alipayPublicKey/notifyUrl/returnUrl',
    updated_at = datetime('now')
WHERE id = 'ch_alipay_web';
