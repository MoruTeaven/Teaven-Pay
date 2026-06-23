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
    
    // D1 数据库
    DB: D1Database;
    
    // KV 缓存
    CACHE: KVNamespace;
    
    // R2 存储 (可选)
    // STORAGE?: R2Bucket;
    
    // 队列 (可选)
    // NOTIFY_QUEUE?: Queue;
    
    // Secrets
    JWT_SECRET?: string;
    ENCRYPTION_KEY?: string;
    ADMIN_PASSWORD?: string;
    
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
    api_key: string | null;
    api_key_type: 'md5' | 'rsa';
    rsa_public_key: string | null;
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

export interface ConfigRow {
    key: string;
    value: string | null;
    description: string | null;
    updated_at: string;
}
