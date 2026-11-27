-- DodoPayments 微信支付复用已有的「微信支付」(pt_wxpay) 类型，不再单独建 pt_dodo_wechat。
-- 理由：对消费者而言 Dodo 微信支付与国内微信支付都是微信扫码，无需两个用户侧类型；
--       区别只在后台通道（Dodo 走境外商户号/美元结算，国内 wxpay 走自有商户号）。
--
-- 插件 dodopayments 的 supportedTypes 已加入 'wxpay'，管理员可在「微信支付」下
-- 建 Dodo 通道，并在通道配置里填 payment_method_type=we_chat_pay。
--
-- ⚠️ 注意：下单按 payment_type_id 查通道时只取 sort_order 最小的一条。
--    现有 pt_wxpay 下已有虎皮椒通道（sort_order=0）。若要让 Dodo 收款，
--    需把 Dodo 通道的 sort_order 设得更小，或停用其它通道，否则仍会走原通道。
--
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。

-- 1) 历史订单归并到已有的微信支付类型
UPDATE orders SET payment_type = 'pt_wxpay' WHERE payment_type = 'pt_dodo_wechat';

-- 2) 删除 Dodo 专用微信支付方式（其自动通道本就不存在，通道只由用户自建）
DELETE FROM channels WHERE payment_type_id = 'pt_dodo_wechat';
DELETE FROM payment_types WHERE id = 'pt_dodo_wechat';
