/**
 * Cloudflare Workers 类型声明
 */

interface Env {
    // 环境变量
    ENVIRONMENT: string;
    DEFAULT_CURRENCY: string;
    LOG_LEVEL: string;
    ENABLE_CORS: string;
    ALLOWED_ORIGINS?: string;
    RATE_LIMIT?: string;
    RATE_LIMIT_WINDOW?: string;
    SITE_URL?: string;
    
    // D1 数据库
    DB: D1Database;
    
    // KV 缓存
    CACHE: KVNamespace;
    
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

// 扩展 Hono Context
declare module 'hono' {
    interface Context {
        get(key: 'user'): any;
        set(key: 'user', value: any): void;
    }
}
