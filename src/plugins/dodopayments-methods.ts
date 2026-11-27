/**
 * DodoPayments 用户侧支付方式清单
 *
 * 数据来源：Dodo 官方文档「Available Method Types」
 * https://docs.dodopayments.com/features/payment-methods.md
 *
 * 这一层只描述「用户可以选什么」，与后台通道（channels）完全无关：
 *  - code 既是 payment_types.name，也是 Dodo API
 *    POST /checkouts 的 allowed_payment_method_types 取值；
 *  - 每种支付方式对应一条 payment_types 记录（默认数据，随迁移入库）；
 *  - 具体走哪个 Dodo 通道、用哪套 API 密钥，由用户自己在后台建通道决定。
 *
 * 注意：不在这里定义任何 channel 默认值。
 */

export interface DodoPaymentMethod {
    /** Dodo 支付方式代码，同时作为 payment_types.name */
    code: string;
    /** 用户侧展示名 */
    displayName: string;
    /** 简要说明（地区 / 币种 / 类型） */
    description: string;
}

/** 官方标准支付方式（29 种） */
export const DODO_PAYMENT_METHODS: readonly DodoPaymentMethod[] = [
    { code: 'credit', displayName: '信用卡', description: 'Visa / Mastercard / Amex / JCB 等，全球通用' },
    { code: 'debit', displayName: '借记卡', description: '全球通用的借记卡' },
    { code: 'apple_pay', displayName: 'Apple Pay', description: '苹果设备钱包支付' },
    { code: 'google_pay', displayName: 'Google Pay', description: '谷歌钱包支付' },
    { code: 'amazon_pay', displayName: 'Amazon Pay', description: '亚马逊钱包支付' },
    { code: 'cashapp', displayName: 'Cash App Pay', description: '美国 Cash App 钱包' },
    { code: 'ach', displayName: 'ACH 直接借记', description: '美国银行账户借记，仅一次性支付' },
    { code: 'klarna', displayName: 'Klarna', description: '先买后付，美国 / 欧洲' },
    { code: 'afterpay_clearpay', displayName: 'Afterpay / Clearpay', description: '先买后付，美国 / 英国' },
    { code: 'upi_intent', displayName: 'UPI', description: '印度统一支付接口（扫码）' },
    { code: 'ideal', displayName: 'iDEAL', description: '荷兰本地银行转账' },
    { code: 'bancontact_card', displayName: 'Bancontact', description: '比利时银行卡支付' },
    { code: 'eps', displayName: 'EPS', description: '奥地利在线银行转账' },
    { code: 'multibanco', displayName: 'Multibanco', description: '葡萄牙本地支付网络' },
    { code: 'blik', displayName: 'BLIK', description: '波兰本地移动支付' },
    { code: 'sepa', displayName: 'SEPA 直接借记', description: '欧元区银行直接借记' },
    { code: 'satispay', displayName: 'Satispay', description: '欧洲移动支付' },
    { code: 'payco', displayName: 'PAYCO', description: '韩国本地钱包' },
    { code: 'naver_pay', displayName: 'Naver Pay', description: '韩国 Naver 钱包' },
    { code: 'kakao_pay', displayName: 'Kakao Pay', description: '韩国 Kakao 钱包' },
    { code: 'revolut_pay', displayName: 'RevolutPay', description: 'Revolut 钱包，以 GBP 结算' },
    { code: 'billie', displayName: 'Billie', description: '企业先买后付（B2B）' },
    { code: 'pix', displayName: 'Pix', description: '巴西即时银行转账' },
    { code: 'crypto_currency', displayName: '稳定币', description: '稳定币支付，以 USD 结算' },
    { code: 'we_chat_pay', displayName: 'WeChat Pay（Dodo）', description: '面向海外用户的微信支付，支持 USD / CNY' },
    { code: 'gcash', displayName: 'GCash', description: '菲律宾电子钱包' },
    { code: 'ali_pay_hk', displayName: 'Alipay HK', description: '香港支付宝，以 HKD 结算' },
    { code: 'fps', displayName: 'FPS', description: '香港快速支付系统' },
    { code: 'touch_n_go', displayName: "Touch 'n Go", description: '马来西亚电子钱包' },
];

/**
 * 插件的 supportedTypes：后台按 payment_types.name 匹配插件，
 * 因此这 29 个 code 就是新增支付方式的 name。
 */
export const DODO_PAYMENT_TYPE_NAMES: string[] = DODO_PAYMENT_METHODS.map((m) => m.code);

/**
 * 把通道配置里的支付方式白名单归一为 Dodo API 需要的字符串数组。
 * 兼容三种写法：未配置（空数组）、单个字符串、字符串数组（逗号分隔亦可）。
 *
 * 只有 Dodo 官方支持的代码会被保留，避免把拼错的值发给渠道导致下单失败。
 */
export function normalizeDodoMethodTypes(input: unknown): string[] {
    if (input === undefined || input === null || input === '') return [];
    const raw = Array.isArray(input)
        ? input
        : String(input).split(',');
    const supported = new Set<string>(DODO_PAYMENT_TYPE_NAMES);
    const result: string[] = [];
    for (const item of raw) {
        const code = String(item).trim().toLowerCase();
        if (code && supported.has(code) && !result.includes(code)) result.push(code);
    }
    return result;
}
