/**
 * 环境变量类型定义
 */

export interface Env {
    // 环境
    ENVIRONMENT: string;
    DEFAULT_CURRENCY: string;
    LOG_LEVEL: string;
    ENABLE_CORS: string;
    ALLOWED_ORIGINS?: string;
    SITE_URL?: string;
    
    // 限流/防爆破可调参数（未配置时使用 throttleStore.ts 中的默认值）
    RATE_LIMIT?: string;
    RATE_LIMIT_WINDOW?: string;
    LOGIN_RATE_LIMIT?: string;
    LOGIN_RATE_LIMIT_WINDOW?: string;
    LOGIN_MAX_FAILURES?: string;
    LOGIN_LOCKOUT_SECONDS?: string;
    
    // D1 数据库
    DB: D1Database;
    
    // KV 缓存（wrangler.toml 中当前未绑定，限流会自动降级到 D1 / 内存计数）
    CACHE?: KVNamespace;
    
    // Secrets
    JWT_SECRET?: string;
    ENCRYPTION_KEY?: string;
    ADMIN_PASSWORD?: string;

    // 邮件发信（Teaven Email 服务）：密码找回等功能依赖
    // 未配置 TEAVEN_EMAIL_API_KEY 时邮件能力视为未启用，相关接口明确报错而不是静默失败
    TEAVEN_EMAIL_API_KEY?: string;
    // Teaven Email 发信端点，可只填服务根地址（自动补 /v1/mail/send）
    TEAVEN_EMAIL_ENDPOINT?: string;
    
    // 支付渠道配置
    ALIPAY_APP_ID?: string;
    ALIPAY_PRIVATE_KEY?: string;
    ALIPAY_PUBLIC_KEY?: string;
    
    WXPAY_APP_ID?: string;
    WXPAY_MCH_ID?: string;
    WXPAY_API_KEY?: string;
    WXPAY_PRIVATE_KEY?: string;
    WXPAY_CERT_SERIAL_NO?: string;
}

/**
 * 数据库行类型
 */

export interface UserRow {
    id: string;
    username: string;
    email: string | null;
    password_hash: string;
    salt: string;
    role: 'admin' | 'merchant';
    status: number;
    balance: number;
    frozen_balance: number;
    notify_url: string | null;
    return_url: string | null;
    contact_qq: string | null;
    contact_wechat: string | null;
    contact_phone: string | null;
    group_id: string | null;
    settle_type: string | null;
    settle_account: string | null;
    settle_name: string | null;
    deposit: number;
    today_income: number;
    total_income: number;
    today_orders: number;
    total_orders: number;
    last_login_at: string | null;
    last_login_ip: string | null;
    created_at: string;
    updated_at: string;
}

export interface ApiKeyRow {
    id: string;
    user_id: string;
    api_key: string;
    name: string;
    api_key_type: 'md5' | 'hmac-sha256' | 'rsa';
    rsa_public_key: string | null;
    status: number;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface OrderRow {
    id: string;
    user_id: string;
    out_trade_no: string;
    payment_type: string;
    channel_id: string | null;
    sub_channel_id: string | null;
    plugin: string | null;
    amount: number;
    actual_amount: number | null;
    fee: number;
    profit: number;
    status: number;
    name: string | null;
    body: string | null;
    param: string | null;
    buyer: string | null;
    buyer_ip: string | null;
    notify_url: string | null;
    return_url: string | null;
    notify_status: number;
    notify_count: number;
    last_notify_at: string | null;
    domain: string | null;
    device: string | null;
    cert_no: string | null;
    cert_name: string | null;
    api_trade_no: string | null;
    refund_amount: number;
    created_at: string;
    paid_at: string | null;
    closed_at: string | null;
}

export interface PaymentTypeRow {
    id: string;
    name: string;
    display_name: string;
    icon: string | null;
    description: string | null;
    sort_order: number;
    status: number;
    config: string | null;
    created_at: string;
    updated_at: string;
}

export interface ChannelRow {
    id: string;
    payment_type_id: string;
    name: string;
    plugin: string;
    config: string | null;
    fee_rate: number;
    min_amount: number;
    max_amount: number;
    daily_limit: number;
    time_start: number | null;
    time_stop: number | null;
    sort_order: number;
    status: number;
    description: string | null;
    created_at: string;
    updated_at: string;
}

export interface SettlementRow {
    id: string;
    user_id: string;
    amount: number;
    fee: number;
    actual_amount: number | null;
    settle_type: string | null;
    settle_account: string | null;
    settle_name: string | null;
    bank_name: string | null;
    bank_branch: string | null;
    status: number;
    reject_reason: string | null;
    processed_at: string | null;
    created_at: string;
}

export interface RefundRow {
    id: string;
    refund_no: string;
    order_id: string;
    user_id: string;
    amount: number;
    reason: string | null;
    status: number;
    third_party_refund_no: string | null;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
}

export interface PasswordResetRow {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: number;
    used_at: number | null;
    attempts: number;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
}

export interface ConfigRow {
    key: string;
    value: string | null;
    description: string | null;
    updated_at: string;
}

export interface OrderLogRow {
    id: string;
    order_id: string;
    user_id: string | null;
    out_trade_no: string | null;
    action: string;
    from_status: number | null;
    to_status: number | null;
    amount: number | null;
    detail: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
}

export interface PaymentLogRow {
    id: string;
    order_id: string | null;
    user_id: string | null;
    channel_id: string | null;
    plugin: string | null;
    direction: string;
    action: string;
    status: string;
    amount: number | null;
    third_party_trade_no: string | null;
    request_data: string | null;
    response_data: string | null;
    error_message: string | null;
    created_at: string;
}

export interface WebhookLogRow {
    id: string;
    order_id: string | null;
    user_id: string | null;
    plugin: string | null;
    webhook_type: string;
    direction: string;
    url: string | null;
    method: string | null;
    http_status: number | null;
    success: number;
    request_headers: string | null;
    request_body: string | null;
    response_body: string | null;
    error_message: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
}

export interface ReconciliationLogRow {
    id: string;
    user_id: string | null;
    payment_type: string | null;
    date: string;
    status: string;
    checked_count: number;
    matched_count: number;
    mismatch_count: number;
    fixed_count: number;
    operator_id: string | null;
    detail: string | null;
    error_message: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
}

/**
 * 限流/登录失败计数表行（migrations/0005_throttle_counters.sql）
 * reset_at 为窗口结束时间（epoch 毫秒）
 */
export interface ThrottleCounterRow {
    key: string;
    count: number;
    reset_at: number;
    updated_at: number;
}
