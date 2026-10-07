-- 限流 / 登录失败计数表
-- 用途：KV(CACHE) 未绑定时的兜底计数存储（见 src/utils/throttleStore.ts）
-- 适用于 Cloudflare D1 (SQLite)
--
-- key 形如：
--   rate_limit:login:1.2.3.4              通用/登录 IP 限流计数
--   login_fail:admin:acct:someone         管理员账号维度失败计数
--   login_fail:merchant:ip:1.2.3.4        商户 IP 维度失败计数

CREATE TABLE IF NOT EXISTS throttle_counters (
    key TEXT PRIMARY KEY,                           -- 计数键（含作用域与 IP/账号）
    count INTEGER NOT NULL DEFAULT 1,               -- 当前窗口内的累计次数
    reset_at INTEGER NOT NULL,                      -- 窗口结束时间（epoch 毫秒）
    updated_at INTEGER NOT NULL                     -- 最后更新时间（epoch 毫秒）
);

-- 清理过期行时按窗口结束时间扫描
CREATE INDEX IF NOT EXISTS idx_throttle_counters_reset_at ON throttle_counters(reset_at);
