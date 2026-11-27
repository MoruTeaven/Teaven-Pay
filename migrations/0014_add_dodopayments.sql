-- 新增交易通道：DodoPayments（一次性支付 / hosted checkout）
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。
-- 通道 config 先落空配置，管理员在后台填入 apiKey / productId / webhookSecret。
-- 要求 productId 是在 Dodo 后台开启了 Pay What You Want 的一次性产品，
-- 否则下单传入的 amount 会被忽略，买家可少付。

-- 支付方式（name=dodopayments 与插件 supportedTypes 一致；收银台传 id=pt_dodopayments）
INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, description, sort_order, status)
VALUES (
    'pt_dodopayments',
    'dodopayments',
    'DodoPayments',
    '/icons/dodopayments.svg',
    'DodoPayments 国际支付，支持信用卡等多种方式',
    7,
    1
);

-- 支付通道（config 为空配置，后台专属表单填写；'{}' 明文可被 decryptChannelConfig 兼容读取）
INSERT OR IGNORE INTO channels (id, payment_type_id, name, plugin, config, fee_rate, sort_order, status, description)
VALUES (
    'ch_dodopayments',
    'pt_dodopayments',
    'DodoPayments',
    'dodopayments',
    '{}',
    0,
    1,
    1,
    '请在后台配置 apiKey(dodo_test_/dodo_live_) / productId(PWYW产品) / webhookSecret(whsec_)，并在 Dodo 控制台把 /notify/dodopayments 设为回调地址'
);
