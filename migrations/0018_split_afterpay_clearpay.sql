-- DodoPayments：把合并的「Afterpay / Clearpay」用户侧支付方式拆成两个独立方式。
--
-- 背景：Dodo API 侧 Afterpay 与 Clearpay 共用一个 method code（afterpay_clearpay），
--       由账单国家/币种决定品牌（US→Afterpay/USD，UK→Clearpay/GBP）。
--       用户侧拆成「Afterpay」「Clearpay」两个选项更清晰，插件把两者都映射回
--       afterpay_clearpay，并用币种区分。
--
-- 注意：0015 中合并类型的真实 id 是 pt_dodo_afterpay（name=afterpay_clearpay）。
--       为避免动到用户自建的通道，这里采用「原地改名」而非删了重建：
--       保留 pt_dodo_afterpay 这个 id，只把 name/display/description 改成 Afterpay。
--       本迁移可重复执行（幂等），不会删除任何通道。
--
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。

-- 1) 历史订单：兼容其它可能的旧 id，统一归并到 pt_dodo_afterpay
UPDATE orders SET payment_type = 'pt_dodo_afterpay' WHERE payment_type = 'pt_dodo_afterpay_clearpay';

-- 2) 原地改名为 Afterpay（保留 id 与其下用户自建的通道）
UPDATE payment_types
SET name = 'afterpay',
    display_name = 'Afterpay',
    icon = 'ri-shopping-bag-line',
    description = '先买后付，美国，以 USD 结算（Dodo method: afterpay_clearpay）',
    sort_order = 108,
    updated_at = datetime('now')
WHERE id = 'pt_dodo_afterpay';

-- 3) 补充 Clearpay（新 id，通道由用户自建）
INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, description, sort_order, status) VALUES
    ('pt_dodo_clearpay', 'clearpay', 'Clearpay', 'ri-shopping-bag-line', '先买后付，英国，以 GBP 结算（Dodo method: afterpay_clearpay）', 109, 1);

-- 4) 兼容极端情况：若曾存在另一个 pt_dodo_afterpay_clearpay 记录，归并掉它（不动其通道的归属）
UPDATE channels SET payment_type_id = 'pt_dodo_afterpay' WHERE payment_type_id = 'pt_dodo_afterpay_clearpay';
UPDATE orders SET payment_type = 'pt_dodo_afterpay' WHERE payment_type = 'pt_dodo_afterpay_clearpay';
DELETE FROM payment_types WHERE id = 'pt_dodo_afterpay_clearpay';
