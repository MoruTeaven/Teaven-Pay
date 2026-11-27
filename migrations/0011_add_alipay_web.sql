-- 新增支付方式：支付宝AI付（AI 网页应用收款 / alipay.trade.page.pay）
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。
-- 通道 config 用 ENCRYPTION_KEY 加密后写入（此处插空配置，管理员在后台填入真实 appId/私钥/支付宝公钥）。
-- 沙箱联调参数见项目根 .alipay-sandbox.json（已 gitignore，不入仓库）。

INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, description, sort_order, status)
VALUES (
    'pt_alipay_web',
    'alipay_web',
    '支付宝',
    '/icons/alipay.svg',
    '支付宝网页收款（电脑网页/手机 H5）',
    7,
    1
);

INSERT OR IGNORE INTO channels (id, payment_type_id, name, plugin, config, fee_rate, sort_order, status, description)
VALUES (
    'ch_alipay_web',
    'pt_alipay_web',
    '支付宝网页收款',
    'alipay_web',
    '{}',
    0.6,
    1,
    1,
    'alipay.trade.page.pay；请在后台配置 appId/privateKey(PKCS#1)/alipayPublicKey/notifyUrl/returnUrl'
);
