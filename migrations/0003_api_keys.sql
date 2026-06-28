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

-- 迁移现有用户的 API 密钥到新表
INSERT INTO api_keys (id, user_id, api_key, name, api_key_type, rsa_public_key, created_at, updated_at)
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
FROM users WHERE api_key IS NOT NULL;

-- 重建 users 表，移除 api_key 相关字段
-- SQLite 不支持 DROP COLUMN，需要重建表

-- 1. 创建临时表
CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'merchant',
    status INTEGER DEFAULT 1,
    balance REAL DEFAULT 0,
    frozen_balance REAL DEFAULT 0,
    notify_url TEXT,
    return_url TEXT,
    contact_qq TEXT,
    contact_wechat TEXT,
    contact_phone TEXT,
    group_id TEXT,
    settle_type TEXT DEFAULT 'alipay',
    settle_account TEXT,
    settle_name TEXT,
    deposit REAL DEFAULT 0,
    today_income REAL DEFAULT 0,
    total_income REAL DEFAULT 0,
    today_orders INTEGER DEFAULT 0,
    total_orders INTEGER DEFAULT 0,
    last_login_at TEXT,
    last_login_ip TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. 迁移数据
INSERT INTO users_new SELECT 
    id, username, email, password_hash, salt, role, status,
    balance, frozen_balance,
    notify_url, return_url,
    contact_qq, contact_wechat, contact_phone,
    group_id,
    settle_type, settle_account, settle_name,
    deposit,
    today_income, total_income, today_orders, total_orders,
    last_login_at, last_login_ip,
    created_at, updated_at
FROM users;

-- 3. 删除旧表
DROP TABLE users;

-- 4. 重命名新表
ALTER TABLE users_new RENAME TO users;

-- 5. 重建 users 表的索引（如果有）
-- 注意：外键约束需要在创建表时定义，这里只是迁移数据
