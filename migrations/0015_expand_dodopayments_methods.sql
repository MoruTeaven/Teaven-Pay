-- DodoPayments：把笼统的「DodoPayments」支付方式展开为用户侧的 29 种具体支付方式。
--
-- 概念区分（重要）：
--   * payment_types = 用户侧支付方式，只描述「用户用什么付款」，本迁移负责导入；
--   * channels      = 后台支付通道，描述「用哪套密钥/产品去收款」，只能由用户自己在后台创建，
--                     本迁移绝不插入任何 channel，也不预置任何 API 密钥/产品 ID。
--
-- 数据来源：Dodo 官方文档「Available Method Types」
--   https://docs.dodopayments.com/features/payment-methods.md
-- name 与 Dodo API 的 allowed_payment_method_types 取值一致，插件据此限定收银台支付方式。
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。

-- 1) 历史订单：旧的通用 pt_dodopayments 归并到信用卡（最接近的默认方式），避免订单显示「未知支付方式」。
UPDATE orders SET payment_type = 'pt_dodo_credit' WHERE payment_type = 'pt_dodopayments';

-- 2) 移除旧的通用支付方式与其自动生成的通道。
--    通道由用户自建，0014 自动创建的空配置通道不应保留。
DELETE FROM channels WHERE id = 'ch_dodopayments';
DELETE FROM payment_types WHERE id = 'pt_dodopayments';

-- 3) 导入 29 种用户侧支付方式（icon 用 Remix Icon 类名，与后台/收银台渲染口径一致）。
INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, description, sort_order, status) VALUES
    ('pt_dodo_credit',          'credit',            '信用卡',              'ri-bank-card-line',     'Visa / Mastercard / Amex / JCB 等，全球通用', 100, 1),
    ('pt_dodo_debit',           'debit',             '借记卡',              'ri-bank-card-2-line',   '全球通用的借记卡', 101, 1),
    ('pt_dodo_apple_pay',       'apple_pay',         'Apple Pay',           'ri-apple-line',         '苹果设备钱包支付', 102, 1),
    ('pt_dodo_google_pay',      'google_pay',        'Google Pay',          'ri-google-line',        '谷歌钱包支付', 103, 1),
    ('pt_dodo_amazon_pay',      'amazon_pay',        'Amazon Pay',          'ri-amazon-line',        '亚马逊钱包支付', 104, 1),
    ('pt_dodo_cashapp',         'cashapp',           'Cash App Pay',        'ri-cash-line',          '美国 Cash App 钱包', 105, 1),
    ('pt_dodo_ach',             'ach',               'ACH 直接借记',        'ri-bank-line',          '美国银行账户借记，仅一次性支付', 106, 1),
    ('pt_dodo_klarna',          'klarna',            'Klarna',              'ri-shopping-bag-line',  '先买后付，美国 / 欧洲', 107, 1),
    ('pt_dodo_afterpay',        'afterpay_clearpay', 'Afterpay / Clearpay', 'ri-shopping-cart-line', '先买后付，美国 / 英国', 108, 1),
    ('pt_dodo_upi',             'upi_intent',        'UPI',                 'ri-qr-code-line',       '印度统一支付接口（扫码）', 109, 1),
    ('pt_dodo_ideal',           'ideal',             'iDEAL',               'ri-bank-line',          '荷兰本地银行转账', 110, 1),
    ('pt_dodo_bancontact',      'bancontact_card',   'Bancontact',          'ri-bank-card-line',     '比利时银行卡支付', 111, 1),
    ('pt_dodo_eps',             'eps',               'EPS',                 'ri-bank-line',          '奥地利在线银行转账', 112, 1),
    ('pt_dodo_multibanco',      'multibanco',        'Multibanco',          'ri-bank-line',          '葡萄牙本地支付网络', 113, 1),
    ('pt_dodo_blik',            'blik',              'BLIK',                'ri-smartphone-line',    '波兰本地移动支付', 114, 1),
    ('pt_dodo_sepa',            'sepa',              'SEPA 直接借记',       'ri-bank-line',          '欧元区银行直接借记', 115, 1),
    ('pt_dodo_satispay',        'satispay',          'Satispay',            'ri-smartphone-line',    '欧洲移动支付', 116, 1),
    ('pt_dodo_payco',           'payco',             'PAYCO',               'ri-wallet-3-line',      '韩国本地钱包', 117, 1),
    ('pt_dodo_naver_pay',       'naver_pay',         'Naver Pay',           'ri-wallet-3-line',      '韩国 Naver 钱包', 118, 1),
    ('pt_dodo_kakao_pay',       'kakao_pay',         'Kakao Pay',           'ri-wallet-3-line',      '韩国 Kakao 钱包', 119, 1),
    ('pt_dodo_revolut_pay',     'revolut_pay',       'RevolutPay',          'ri-wallet-3-line',      'Revolut 钱包，以 GBP 结算', 120, 1),
    ('pt_dodo_billie',          'billie',            'Billie',              'ri-file-list-3-line',   '企业先买后付（B2B）', 121, 1),
    ('pt_dodo_pix',             'pix',               'Pix',                 'ri-qr-code-line',       '巴西即时银行转账', 122, 1),
    ('pt_dodo_crypto',          'crypto_currency',   '稳定币',              'ri-coin-line',          '稳定币支付，以 USD 结算', 123, 1),
    ('pt_dodo_wechat',          'we_chat_pay',       'WeChat Pay（Dodo）',  'ri-wechat-pay-line',    '面向海外用户的微信支付，支持 USD / CNY', 124, 1),
    ('pt_dodo_gcash',           'gcash',             'GCash',               'ri-wallet-3-line',      '菲律宾电子钱包', 125, 1),
    ('pt_dodo_alipay_hk',       'ali_pay_hk',        'Alipay HK',           'ri-alipay-line',        '香港支付宝，以 HKD 结算', 126, 1),
    ('pt_dodo_fps',             'fps',               'FPS',                 'ri-exchange-line',      '香港快速支付系统', 127, 1),
    ('pt_dodo_touch_n_go',      'touch_n_go',        'Touch ''n Go',        'ri-wallet-3-line',      '马来西亚电子钱包', 128, 1);
