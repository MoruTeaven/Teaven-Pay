-- 为「无启用 API 密钥」的商户补种默认密钥（任务 t-mv3a8kcw）
--
-- 背景：
--   收银台 GET /pay/:merchantId 与支付 API 都从 api_keys 表读取 status = 1 的密钥，
--   读不到即返回「商户未配置 API 密钥」。生产库曾出现 api_keys 表 0 行、
--   唯一商户无任何密钥的情况，导致收银台不可下单。
--
--   成因：该商户创建于「创建商户时顺带建默认密钥」逻辑上线之前，
--   而 migrations/0003_api_keys.sql 只迁移 users.api_key 非空的存量商户；
--   生产 users 表缺少 api_key / api_key_type / rsa_public_key 三列（结构漂移），
--   该迁移在生产上无法重放。于是商户既没有旧字段可迁移，也没有新密钥记录。
--
-- 本迁移做的事：
--   为每个 role = 'merchant' 且 status = 1、但在 api_keys 中没有启用密钥的商户，
--   补种一条 hmac-sha256 默认密钥。密钥由 SQLite 的 randomblob(16) 就地生成，
--   不经过任何外部通道，也不写入日志。
--
-- 安全性：
--   - 幂等：NOT EXISTS 子查询保证已有启用密钥的商户不会被重复插入，
--     重复执行不会新增行，也不会覆盖商户自行创建/重置过的密钥；
--   - 不触碰 users 表结构，不依赖 users.api_key 旧列（生产上并不存在）；
--   - 仅处理 role = 'merchant' AND status = 1，不影响管理员与已封禁商户。

INSERT INTO api_keys (id, user_id, api_key, name, api_key_type, status, created_at, updated_at)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    u.id,
    lower(hex(randomblob(16))),
    '默认密钥',
    'hmac-sha256',
    1,
    datetime('now'),
    datetime('now')
FROM users u
WHERE u.role = 'merchant'
  AND u.status = 1
  AND NOT EXISTS (
      SELECT 1 FROM api_keys k
      WHERE k.user_id = u.id AND k.status = 1
  );
