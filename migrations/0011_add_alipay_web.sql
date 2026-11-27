-- 新增通道：支付宝网页收款（alipay.trade.page.pay）
-- 支付方式复用原有的「支付宝」（pt_alipay），不新建重复支付方式。
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。
-- 通道 config 用 ENCRYPTION_KEY 加密后写入（此处插空配置，管理员在后台填入真实 appId/私钥/支付宝公钥）。
-- 沙箱联调参数见项目根 .alipay-sandbox.json（已 gitignore，不入仓库）。

-- 应用私钥由管理员填入的通道配置提供，勿写死；此处仅落空配置。
INSERT OR IGNORE INTO channels (id, payment_type_id, name, plugin, config, fee_rate, sort_order, status, description)
VALUES (
    'ch_alipay_web',
    'pt_alipay',
    '支付宝网页收款',
    'alipay_web',
    '{}',
    0.6,
    1,
    1,
    'alipay.trade.page.pay；请在后台配置 appId/privateKey(PKCS#1)/alipayPublicKey/notifyUrl/returnUrl'
);
