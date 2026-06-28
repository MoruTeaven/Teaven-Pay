-- API 密钥表迁移
-- 将 users 表中的 api_key 字段迁移到独立的 api_keys 表

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
