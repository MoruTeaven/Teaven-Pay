-- API 密钥表迁移
-- 将 users 表中的 api_key 字段迁移到独立的 api_keys 表
-- 保留 users 表的原字段以兼容外键约束，后续版本再清理

-- 创建 api_keys 表
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,                              -- UUID v7
    user_id TEXT NOT NULL,                            -- 商户ID
    api_key TEXT NOT NULL UNIQUE,                     -- API密钥
    name TEXT NOT NULL DEFAULT '默认密钥',             -- 备注名称
    api_key_type TEXT DEFAULT 'hmac-sha256',          -- 签名类型: md5/hmac-sha256/rsa
    rsa_public_key TEXT,                              -- RSA公钥
    status INTEGER DEFAULT 1,                         -- 状态: 0禁用 1启用
    last_used_at TEXT,                                -- 最后使用时间
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    updated_at TEXT DEFAULT (datetime('now')),        -- 更新时间
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_api_key ON api_keys(api_key);

-- 迁移现有用户的 API 密钥到新表（如果还没有迁移过）
INSERT OR IGNORE INTO api_keys (id, user_id, api_key, name, api_key_type, rsa_public_key, created_at, updated_at)
SELECT 
    lower(hex(randomblob(16))) || lower(hex(randomblob(2))) || '-' || 
    lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || 
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || 
    lower(hex(randomblob(6))),
    id, 
    api_key, 
    '默认密钥', 
    api_key_type, 
    rsa_public_key,
    created_at,
    updated_at
FROM users WHERE api_key IS NOT NULL
AND id NOT IN (SELECT user_id FROM api_keys);
