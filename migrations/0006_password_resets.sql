-- 密码找回（忘记密码）令牌表
-- 适用于 Cloudflare D1 (SQLite)
--
-- 安全设计：
--   1. 只落库令牌的 HMAC-SHA256 摘要（token_hash），数据库泄露也无法反推出可用链接；
--   2. 一次性使用（used_at 非空即失效），过期时间由 expires_at 控制；
--   3. 每次发起找回都会作废该用户此前未使用的令牌，避免多链接同时有效。

CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,                              -- UUID v7
    user_id TEXT NOT NULL,                            -- 用户ID（users.id）
    token_hash TEXT NOT NULL,                         -- 令牌摘要 HMAC-SHA256(secret, token)
    expires_at INTEGER NOT NULL,                      -- 过期时间（epoch 毫秒）
    used_at INTEGER,                                  -- 使用时间（epoch 毫秒），NULL 表示未使用
    attempts INTEGER NOT NULL DEFAULT 0,              -- 校验失败次数
    ip TEXT,                                          -- 发起找回的 IP
    user_agent TEXT,                                  -- 发起找回的 User Agent
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets(expires_at);
