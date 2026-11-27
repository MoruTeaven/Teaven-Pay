/**
 * 展示名解析
 *
 * 前端一律展示「名称」而不是内部标识：
 *  - 支付方式：payment_types.name / Dodo method code / pt_ 前缀 id → 用户可见名称
 *  - 插件：插件注册 ID（alipay_web 等）→ 插件名
 *
 * 供服务端直出页面（收银台 /cashier）与管理后台 API 复用；
 * 内联在 HTML 里的前端脚本因无法 import，各自维护一份等价映射。
 */

import { getPluginList } from '../plugins';
import { DODO_PAYMENT_METHODS } from '../plugins/dodopayments-methods';

/** 支付方式标识 → 展示名（内置基础项 + Dodo 全量项） */
const PAYMENT_TYPE_NAMES: Record<string, string> = {
    alipay: '支付宝',
    alipay_web: '支付宝',
    wxpay: '微信支付',
    qqpay: 'QQ钱包',
    xunhupay: '虎皮椒',
    dodopayments: 'DodoPayments',
    unionpay: '银联',
    jdpay: '京东支付',
};

for (const method of DODO_PAYMENT_METHODS) {
    PAYMENT_TYPE_NAMES[method.code] = method.displayName;
}

/**
 * 支付方式标识 → 展示名。
 * 兼容 orders.payment_type 存的 pt_ 前缀 id、name 短名与 Dodo method code。
 * 查不到时原样返回标识，保证不丢信息。
 */
export function getPaymentTypeName(type: string): string {
    if (!type) return '';
    const key = type.replace(/^pt_/, '');
    return PAYMENT_TYPE_NAMES[key] || PAYMENT_TYPE_NAMES[type] || type;
}

/**
 * 优先用数据库 display_name，缺失时回退到标识映射。
 */
export function getPaymentTypeDisplayName(displayName: string | null | undefined, type: string): string {
    if (displayName) return displayName;
    return getPaymentTypeName(type) || '未知支付方式';
}

/** 插件 ID → 插件名（注册表是静态的，构建一次 Map 复用） */
let pluginNameMap: Map<string, string> | null = null;

export function getPluginName(pluginId: string): string {
    if (!pluginId) return '';
    if (!pluginNameMap) {
        pluginNameMap = new Map(getPluginList().map((p) => [p.id, p.name]));
    }
    return pluginNameMap.get(pluginId) || pluginId;
}
