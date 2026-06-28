-- Teaven Pay 数据库初始化脚本
-- 适用于 Cloudflare D1 (SQLite)

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                              -- UUID v7
    username TEXT NOT NULL UNIQUE,                    -- 用户名
    email TEXT UNIQUE,                                -- 邮箱
    password_hash TEXT NOT NULL,                      -- 密码哈希 (PBKDF2 77777次)
    salt TEXT NOT NULL,                               -- 密码盐
    role TEXT NOT NULL DEFAULT 'merchant',            -- 角色: admin/merchant
    status INTEGER DEFAULT 1,                         -- 状态: 0禁用 1正常 2待审核
    balance REAL DEFAULT 0,                           -- 可用余额
    frozen_balance REAL DEFAULT 0,                    -- 冻结余额
    api_key TEXT UNIQUE,                              -- API密钥
    api_key_type TEXT DEFAULT 'hmac-sha256',          -- 密钥类型: md5/hmac-sha256/rsa
    rsa_public_key TEXT,                              -- RSA公钥
    notify_url TEXT,                                  -- 默认异步通知地址
    return_url TEXT,                                  -- 默认同步跳转地址
    contact_qq TEXT,                                  -- 联系QQ
    contact_wechat TEXT,                              -- 联系微信
    contact_phone TEXT,                               -- 联系电话
    group_id TEXT,                                    -- 用户组ID
    settle_type TEXT DEFAULT 'alipay',                -- 结算方式: alipay/bank/wechat
    settle_account TEXT,                              -- 结算账号
    settle_name TEXT,                                 -- 结算姓名
    deposit REAL DEFAULT 0,                           -- 保证金
    today_income REAL DEFAULT 0,                      -- 今日收入
    total_income REAL DEFAULT 0,                      -- 总收入
    today_orders INTEGER DEFAULT 0,                   -- 今日订单数
    total_orders INTEGER DEFAULT 0,                   -- 总订单数
    last_login_at TEXT,                               -- 最后登录时间
    last_login_ip TEXT,                               -- 最后登录IP
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    updated_at TEXT DEFAULT (datetime('now'))         -- 更新时间
);

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,                              -- UUID v7 (平台订单号 trade_no)
    user_id TEXT NOT NULL,                            -- 商户ID
    out_trade_no TEXT NOT NULL,                       -- 商户订单号
    payment_type TEXT NOT NULL,                       -- 支付方式: alipay/wxpay/qqpay
    channel_id TEXT,                                  -- 支付通道ID
    sub_channel_id TEXT,                              -- 子通道ID
    plugin TEXT,                                      -- 支付插件标识
    amount REAL NOT NULL,                             -- 订单金额
    actual_amount REAL,                               -- 实际支付金额
    fee REAL DEFAULT 0,                               -- 手续费
    profit REAL DEFAULT 0,                            -- 利润
    status INTEGER DEFAULT 0,                         -- 状态: 0未支付 1已支付 2已退款 3已关闭
    name TEXT,                                        -- 商品名称
    body TEXT,                                        -- 商品描述
    param TEXT,                                       -- 自定义参数
    buyer TEXT,                                       -- 买家信息
    buyer_ip TEXT,                                    -- 买家IP
    notify_url TEXT,                                  -- 异步通知地址
    return_url TEXT,                                  -- 同步跳转地址
    notify_status INTEGER DEFAULT 0,                  -- 通知状态: 0未通知 1已通知 2通知失败
    notify_count INTEGER DEFAULT 0,                   -- 通知次数
    last_notify_at TEXT,                              -- 最后通知时间
    domain TEXT,                                      -- 来源域名
    device TEXT,                                      -- 设备类型
    cert_no TEXT,                                     -- 身份证号
    cert_name TEXT,                                   -- 身份证姓名
    api_trade_no TEXT,                                -- 第三方交易号
    refund_amount REAL DEFAULT 0,                     -- 已退款金额
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    paid_at TEXT,                                     -- 支付时间
    closed_at TEXT,                                   -- 关闭时间
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 支付方式表
CREATE TABLE IF NOT EXISTS payment_types (
    id TEXT PRIMARY KEY,                              -- UUID v7
    name TEXT NOT NULL UNIQUE,                        -- 标识: alipay/wxpay/qqpay
    display_name TEXT NOT NULL,                       -- 显示名称
    icon TEXT,                                        -- 图标URL
    description TEXT,                                 -- 描述
    sort_order INTEGER DEFAULT 0,                     -- 排序
    status INTEGER DEFAULT 1,                         -- 状态: 0禁用 1启用
    config TEXT,                                      -- 配置 (JSON)
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    updated_at TEXT DEFAULT (datetime('now'))         -- 更新时间
);

-- 支付通道表
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,                              -- UUID v7
    payment_type_id TEXT NOT NULL,                    -- 支付方式ID
    name TEXT NOT NULL,                               -- 通道名称
    plugin TEXT NOT NULL,                             -- 插件标识
    config TEXT,                                      -- 配置 (JSON, 加密存储)
    fee_rate REAL DEFAULT 0,                          -- 费率 (%)
    min_amount REAL DEFAULT 0,                        -- 最小金额
    max_amount REAL DEFAULT 0,                        -- 最大金额
    daily_limit REAL DEFAULT 0,                       -- 每日限额
    time_start INTEGER,                               -- 开始时间 (小时)
    time_stop INTEGER,                                -- 结束时间 (小时)
    sort_order INTEGER DEFAULT 0,                     -- 排序
    status INTEGER DEFAULT 1,                         -- 状态: 0禁用 1启用
    description TEXT,                                 -- 描述
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    updated_at TEXT DEFAULT (datetime('now')),        -- 更新时间
    FOREIGN KEY (payment_type_id) REFERENCES payment_types(id)
);

-- 结算记录表
CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,                              -- UUID v7
    user_id TEXT NOT NULL,                            -- 商户ID
    amount REAL NOT NULL,                             -- 结算金额
    fee REAL DEFAULT 0,                               -- 手续费
    actual_amount REAL,                               -- 实际到账金额
    settle_type TEXT,                                 -- 结算方式
    settle_account TEXT,                              -- 结算账号
    settle_name TEXT,                                 -- 结算姓名
    bank_name TEXT,                                   -- 银行名称
    bank_branch TEXT,                                 -- 支行名称
    status INTEGER DEFAULT 0,                         -- 状态: 0待处理 1处理中 2已处理 3已拒绝
    reject_reason TEXT,                               -- 拒绝原因
    processed_at TEXT,                                -- 处理时间
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 退款记录表
CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,                              -- UUID v7
    refund_no TEXT NOT NULL UNIQUE,                   -- 退款单号
    order_id TEXT NOT NULL,                           -- 订单ID
    user_id TEXT NOT NULL,                            -- 商户ID
    amount REAL NOT NULL,                             -- 退款金额
    reason TEXT,                                      -- 退款原因
    status INTEGER DEFAULT 0,                         -- 状态: 0处理中 1成功 2失败
    third_party_refund_no TEXT,                       -- 第三方退款号
    error_message TEXT,                               -- 错误信息
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    completed_at TEXT,                                -- 完成时间
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 用户组表
CREATE TABLE IF NOT EXISTS user_groups (
    id TEXT PRIMARY KEY,                              -- UUID v7
    name TEXT NOT NULL,                               -- 组名
    description TEXT,                                 -- 描述
    fee_rate REAL DEFAULT 0,                          -- 默认费率
    min_amount REAL DEFAULT 0,                        -- 最小金额
    max_amount REAL DEFAULT 0,                        -- 最大金额
    daily_limit REAL DEFAULT 0,                       -- 每日限额
    permissions TEXT,                                 -- 权限 (JSON)
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    updated_at TEXT DEFAULT (datetime('now'))         -- 更新时间
);

-- 黑名单表
CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                               -- 类型: ip/email/phone/domain
    content TEXT NOT NULL,                            -- 内容
    reason TEXT,                                      -- 原因
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    UNIQUE(type, content)
);

-- 域名白名单表
CREATE TABLE IF NOT EXISTS domain_whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,                            -- 商户ID
    domain TEXT NOT NULL,                             -- 域名
    status INTEGER DEFAULT 1,                         -- 状态: 0禁用 1启用
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, domain)
);

-- 操作日志表
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,                                     -- 操作用户ID
    action TEXT NOT NULL,                             -- 操作类型
    target TEXT,                                      -- 操作目标
    detail TEXT,                                      -- 详细信息 (JSON)
    ip TEXT,                                          -- 操作IP
    user_agent TEXT,                                  -- User Agent
    created_at TEXT DEFAULT (datetime('now'))         -- 创建时间
);

-- 支付统计表 (按日)
CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                               -- 日期
    user_id TEXT,                                     -- 商户ID (NULL表示全局)
    payment_type TEXT,                                -- 支付方式
    order_count INTEGER DEFAULT 0,                    -- 订单数
    success_count INTEGER DEFAULT 0,                  -- 成功订单数
    total_amount REAL DEFAULT 0,                      -- 总金额
    success_amount REAL DEFAULT 0,                    -- 成功金额
    fee REAL DEFAULT 0,                               -- 手续费
    profit REAL DEFAULT 0,                            -- 利润
    created_at TEXT DEFAULT (datetime('now')),        -- 创建时间
    UNIQUE(date, user_id, payment_type)
);

-- 系统配置表
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,                             -- 配置键
    value TEXT,                                       -- 配置值
    description TEXT,                                 -- 描述
    updated_at TEXT DEFAULT (datetime('now'))         -- 更新时间
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_out_trade_no ON orders(out_trade_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_payment_type ON orders(payment_type);
CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user_id ON refunds(user_id);
CREATE INDEX IF NOT EXISTS idx_settlements_user_id ON settlements(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_user_id ON operation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_user_id ON daily_stats(user_id);

-- 插入默认配置
INSERT OR IGNORE INTO system_config (key, value, description) VALUES 
    ('site_name', 'Teaven Pay', '站点名称'),
    ('site_url', '', '站点URL'),
    ('admin_email', '', '管理员邮箱'),
    ('enable_register', '1', '是否开启注册'),
    ('enable_review', '0', '是否开启商户审核'),
    ('min_settle_amount', '100', '最低结算金额'),
    ('settle_fee', '1', '结算手续费'),
    ('notify_retry_count', '5', '通知重试次数'),
    ('notify_retry_interval', '1,5,30,60,360', '通知重试间隔(分钟)'),
    ('order_expire_minutes', '30', '订单过期时间(分钟)'),
    ('enable_ip_whitelist', '0', '是否开启IP白名单'),
    ('enable_domain_whitelist', '0', '是否开启域名白名单'),
    ('enable_cert_verify', '0', '是否开启实名认证'),
    ('enable_risk_control', '1', '是否开启风控');

-- 插入默认支付方式
INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, sort_order, status) VALUES 
    ('pt_alipay', 'alipay', '支付宝', '/icons/alipay.svg', 1, 1),
    ('pt_wxpay', 'wxpay', '微信支付', '/icons/wxpay.svg', 2, 1),
    ('pt_qqpay', 'qqpay', 'QQ钱包', '/icons/qqpay.svg', 3, 1),
    ('pt_unionpay', 'unionpay', '银联', '/icons/unionpay.svg', 4, 1),
    ('pt_jdpay', 'jdpay', '京东支付', '/icons/jdpay.svg', 5, 1);

-- 插入默认用户组
INSERT OR IGNORE INTO user_groups (id, name, description, fee_rate) VALUES 
    ('group_default', '默认用户组', '默认用户组', 0.6),
    ('group_vip', 'VIP用户组', 'VIP用户组，享受更低费率', 0.4);

-- 插入默认管理员账号
-- 密码: admin123 (PBKDF2 77777次哈希)
-- 注意: 实际部署时应该修改密码
INSERT OR IGNORE INTO users (id, username, email, password_hash, salt, role, status) VALUES 
    ('user_admin', 'admin', 'admin@example.com', 
     'c91aa403f5908f83cb8b167a07d6168bab0653ce9db7ad4a90ade63453c1a6b9', 
     'ca3ac51bcfe3cb34c13f2d59c14aecb4', 
     'admin', 1);
