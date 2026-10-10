-- 统一 API 密钥来源（任务 t-mukt085p）
--
-- 背景：
--   migrations/0003_api_keys.sql 已把 users.api_key 迁移到独立的 api_keys 表，
--   但 users.api_key / api_key_type / rsa_public_key 三个旧字段一直保留，
--   代码里仍存在两处读取（middleware/auth.ts 比对密钥、notify.ts 出站通知签名）。
--   于是同一商户存在两份密钥副本：面板重置密钥只改 api_keys 表，
--   users.api_key 保持旧值，导致「入站验签用新密钥、出站通知签名用旧密钥」，
--   商户侧通知验签必然失败。
--
-- 本迁移做的事：
--   在 api_keys 表已存在该商户「启用中」密钥的前提下，清空旧字段的密钥副本，
--   使数据库里只剩 api_keys 一个密钥来源；旧字段此后仅保留列定义，
--   任何代码都不得再读取（读取点已全部移除）。
--
-- 安全性说明：
--   - 仅清空「api_keys 中确有 status = 1 记录」的商户，未迁移完成的商户不受影响，
--     不会出现商户彻底无法验签的情况；
--   - 未删除列定义，因此不触碰 users 表结构与既有外键，可在生产库安全执行；
--   - 部署顺序：必须先上线「不再读取 users.api_key」的代码，再执行本迁移，
--     否则旧版本代码会因读不到密钥而无法验签。
--
-- SQLite 不支持直接 DROP 一个带 UNIQUE 约束的列（users.api_key 是 UNIQUE），
-- 所以这里不做表重建，仅清除数据副本。

UPDATE users
SET api_key = NULL,
    api_key_type = NULL,
    rsa_public_key = NULL
WHERE api_key IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM api_keys
      WHERE api_keys.user_id = users.id
        AND api_keys.status = 1
  );
