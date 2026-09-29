-- 等保相关安全审计与支付链路日志
-- 适用于 Cloudflare D1 (SQLite)

-- 订单生命周期日志
CREATE TABLE IF NOT EXISTS order_logs (
    id TEXT PRIMARY KEY,                              -- UUID v7
    order_id TEXT NOT NULL,                           -- 平台订单号
    user_id TEXT,                                     -- 商户ID
    out_trade_no TEXT,                                -- 商户订单号
    action TEXT NOT NULL,                             -- 动作: created/paid/closed/refund_requested/status_changed
    from_status INTEGER,                              -- 变更前状态
    to_status INTEGER,                                -- 变更后状态
    amount REAL,                                      -- 关联金额
    detail TEXT,                                      -- 详情(JSON, 已脱敏)
    ip TEXT,                                          -- 操作来源IP
    user_agent TEXT,                                  -- User Agent
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- 支付流水日志：记录与支付渠道交互及内部支付状态确认
CREATE TABLE IF NOT EXISTS payment_logs (
    id TEXT PRIMARY KEY,                              -- UUID v7
    order_id TEXT,                                    -- 平台订单号
    user_id TEXT,                                     -- 商户ID
    channel_id TEXT,                                  -- 支付通道ID
    plugin TEXT,                                      -- 支付插件
    direction TEXT NOT NULL,                          -- 方向: request/response/internal
    action TEXT NOT NULL,                             -- 动作: create_payment/query_order/refund/reconcile
    status TEXT NOT NULL,                             -- 结果: success/failed/pending/accepted/error
    amount REAL,                                      -- 关联金额
    third_party_trade_no TEXT,                        -- 第三方交易号
    request_data TEXT,                                -- 请求摘要(JSON, 已脱敏)
    response_data TEXT,                               -- 响应摘要(JSON, 已脱敏)
    error_message TEXT,                               -- 错误信息
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- 回调日志：同时覆盖支付渠道回调和平台给商户的异步通知
CREATE TABLE IF NOT EXISTS webhook_logs (
    id TEXT PRIMARY KEY,                              -- UUID v7
    order_id TEXT,                                    -- 平台订单号
    user_id TEXT,                                     -- 商户ID
    plugin TEXT,                                      -- 支付插件
    webhook_type TEXT NOT NULL,                       -- 类型: channel_notify/merchant_notify
    direction TEXT NOT NULL,                          -- 方向: inbound/outbound
    url TEXT,                                         -- 回调URL
    method TEXT,                                      -- HTTP 方法
    http_status INTEGER,                              -- HTTP 状态码
    success INTEGER DEFAULT 0,                        -- 是否成功: 0否 1是
    request_headers TEXT,                             -- 请求头摘要(JSON, 已脱敏)
    request_body TEXT,                                -- 请求体摘要(JSON, 已脱敏)
    response_body TEXT,                               -- 响应摘要(JSON, 已脱敏)
    error_message TEXT,                               -- 错误信息
    ip TEXT,                                          -- 来源IP
    user_agent TEXT,                                  -- User Agent
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- 对账日志：记录每次对账任务的范围、结果和差异详情
CREATE TABLE IF NOT EXISTS reconciliation_logs (
    id TEXT PRIMARY KEY,                              -- UUID v7
    user_id TEXT,                                     -- 对账商户ID，NULL表示全部
    payment_type TEXT,                                -- 支付方式，NULL表示全部
    date TEXT NOT NULL,                               -- 对账日期 YYYY-MM-DD
    status TEXT NOT NULL,                             -- 结果: running/success/failed
    checked_count INTEGER DEFAULT 0,                  -- 检查订单数
    matched_count INTEGER DEFAULT 0,                  -- 一致订单数
    mismatch_count INTEGER DEFAULT 0,                 -- 差异订单数
    fixed_count INTEGER DEFAULT 0,                    -- 已修复订单数
    operator_id TEXT,                                 -- 操作人ID
    detail TEXT,                                      -- 差异详情(JSON, 已脱敏)
    error_message TEXT,                               -- 错误信息
    started_at TEXT,                                  -- 开始时间
    finished_at TEXT,                                 -- 结束时间
    created_at TEXT DEFAULT (datetime('now'))         -- 创建时间
);

CREATE INDEX IF NOT EXISTS idx_order_logs_order_id ON order_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_logs_user_id ON order_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_order_logs_action ON order_logs(action);
CREATE INDEX IF NOT EXISTS idx_order_logs_created_at ON order_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_payment_logs_order_id ON payment_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_user_id ON payment_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_plugin ON payment_logs(plugin);
CREATE INDEX IF NOT EXISTS idx_payment_logs_action ON payment_logs(action);
CREATE INDEX IF NOT EXISTS idx_payment_logs_status ON payment_logs(status);
CREATE INDEX IF NOT EXISTS idx_payment_logs_created_at ON payment_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_order_id ON webhook_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_user_id ON webhook_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_plugin ON webhook_logs(plugin);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_type ON webhook_logs(webhook_type);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_success ON webhook_logs(success);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_date ON reconciliation_logs(date);
CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_user_id ON reconciliation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_payment_type ON reconciliation_logs(payment_type);
CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_status ON reconciliation_logs(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_created_at ON reconciliation_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs(action);
CREATE INDEX IF NOT EXISTS idx_operation_logs_target ON operation_logs(target);
