/**
 * 交付类型契约
 *
 * 软件下单时可传 expected_type 声明预期拿到什么，服务端据此挑通道；
 * 找不到支持该类型的通道时降级到默认通道，并在响应里回传实际交付类型 type，
 * 由软件按实际类型渲染。
 *
 * 对外统一类型：qrcode / link / form / jsapi
 * 插件内部 method 的 jump 对外统一表述为 link。
 */

import type { DeliveryType, PaymentResult } from '../types/plugin';

const ALL_TYPES: readonly string[] = ['qrcode', 'link', 'form', 'jsapi'];

/** 校验外部传入的 expected_type 是否是合法交付类型 */
export function isDeliveryType(value: unknown): value is DeliveryType {
    return typeof value === 'string' && ALL_TYPES.includes(value);
}

/**
 * 插件内部 method → 对外交付类型。
 * jump 对外统一为 link。
 */
export function methodToDeliveryType(method: PaymentResult['method'] | undefined): DeliveryType {
    switch (method) {
        case 'qrcode': return 'qrcode';
        case 'form': return 'form';
        case 'jsapi': return 'jsapi';
        case 'jump':
        default: return 'link';
    }
}

/**
 * 按实际返回内容判定交付类型。
 *
 * 不能只看 method：虎皮椒 method=jump 但同时返回 qrcode 与 payUrl，
 * 这类插件应判为 qrcode，才能与 expected_type=qrcode 对上。
 * 内容字段都不存在时才回退到 method 映射。
 */
export function resolveDeliveryType(result: PaymentResult): DeliveryType {
    if (result.qrcode) return 'qrcode';
    if (result.formHtml) return 'form';
    if (result.jsapiParams) return 'jsapi';
    if (result.payUrl) return 'link';
    return methodToDeliveryType(result.method);
}
