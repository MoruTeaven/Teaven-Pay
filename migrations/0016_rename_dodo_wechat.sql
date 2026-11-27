-- 修正 DodoPayments 微信支付的展示名与描述：
-- 去掉 "(Dodo)" 后缀（WeChat Pay 与「微信支付」已足够区分），
-- 并纠正 0015 中「面向海外用户」的错误描述——官方文档明确是给中国客户使用。
-- 生产库迁移为人工逐文件执行，故只新增本文件，不改动历史迁移。

UPDATE payment_types
SET display_name = 'WeChat Pay',
    description = '微信扫码支付，支持 USD / CNY，单笔上限 1000 CNY'
WHERE id = 'pt_dodo_wechat';
