-- DodoPayments：把合并的「Afterpay / Clearpay」用户侧支付方式拆成两个独立方式。
--
-- 背景：Dodo API 侧 Afterpay 与 Clearpay 共用一个 method code（afterpay_clearpay），
--       由账单国家/币种决定品牌（US→Afterpay/USD，UK→Clearpay/GBP）。
--       但在用户侧拆成「Afterpay」「Clearpay」两个选项更清晰，
--       插件会把两者都映射回 afterpay_clearpay，并用币种区分（USD / GBP）。
--
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。

-- 1) 历史订单归并：原合并类型 → Afterpay（默认）
UPDATE orders SET payment_type = 'pt_dodo_afterpay' WHERE payment_type = 'pt_dodo_afterpay_clearpay';

-- 2) 删除合并类型（其通道本就不存在，通道只由用户自建）
DELETE FROM channels WHERE payment_type_id = 'pt_dodo_afterpay_clearpay';
DELETE FROM payment_types WHERE id = 'pt_dodo_afterpay_clearpay';

-- 3) 新增两个独立的用户侧支付方式
INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, description, sort_order, status) VALUES
    ('pt_dodo_afterpay', 'afterpay', 'Afterpay', 'ri-shopping-bag-line', '先买后付，美国，以 USD 结算（Dodo method: afterpay_clearpay）', 108, 1),
    ('pt_dodo_clearpay', 'clearpay', 'Clearpay', 'ri-shopping-bag-line', '先买后付，英国，以 GBP 结算（Dodo method: afterpay_clearpay）', 109, 1);
