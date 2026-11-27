/**
 * 支付宝网页收款插件（alipay.trade.page.pay）
 *
 * 覆盖：下单并返回自动提交表单、交易查询、退款、退款查询、关闭交易、异步通知验签。
 * 运行于 Cloudflare Workers，签名/验签走 Web Crypto（见 utils/alipayCrypto.ts）。
 */

import {
    PaymentPlugin,
    OrderInfo,
    PluginConfig,
    PaymentResult,
    NotifyResult,
    OrderStatus,
    RefundResult,
    RefundStatus
} from '../types/plugin';
import {
    alipaySign,
    alipayVerify,
    buildAlipaySignString,
    extractRawJsonValue,
    formatAlipayTimestamp
} from '../utils/alipayCrypto';
import { generateRefundNo } from '../utils/uuid';

const PRODUCTION_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

/** 付款成功状态；同时必须不是退款/关单/分账事件 */
const PAID_STATUSES = ['TRADE_SUCCESS', 'TRADE_FINISHED'];
const CLOSED_STATUSES = ['TRADE_CLOSED'];

interface AlipayWebConfig extends PluginConfig {
    /** 应用私钥（PKCS#1 / PKCS#8 均可，非 Java 推荐 PKCS#1） */
    privateKey?: string;
    /** 沙箱配置 appIds[0].appPrivatePkcsKey 的标准字段名，作为 privateKey 的别名 */
    appPrivatePkcsKey?: string;
    alipayPublicKey?: string;
    gateway?: string;
    sandbox?: boolean | string;
    sellerId?: string;
    sellerEmail?: string;
}

/**
 * 解析应用私钥。兼容三种配置来源：
 *  1. privateKey（后台渠道配置填写）
 *  2. appPrivatePkcsKey（沙箱 appIds[0] 的字段名，非 Java 用 PKCS#1）
 *  3. appSecret（通用 PluginConfig 字段兜底）
 * 原始值不做任何 PEM 头尾/格式加工（见 alipayCrypto.ts）。
 */
function resolvePrivateKey(cfg: AlipayWebConfig): string {
    return cfg.privateKey || cfg.appPrivatePkcsKey || cfg.appSecret || '';
}

function escHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function gatewayOf(config: AlipayWebConfig): string {
    if (config.gateway) return config.gateway;
    const sandbox = config.sandbox === true || config.sandbox === 'true' || config.sandbox === '1';
    return sandbox ? SANDBOX_GATEWAY : PRODUCTION_GATEWAY;
}

/** 统一公共请求参数（不含 sign），私钥由配置提供 */
async function buildCommonParams(method: string, config: AlipayWebConfig, bizContent: object): Promise<Record<string, string>> {
    const params: Record<string, string> = {
        app_id: config.appId,
        method,
        format: 'JSON',
        charset: 'utf-8',
        sign_type: 'RSA2',
        timestamp: formatAlipayTimestamp(),
        version: '1.0',
        biz_content: JSON.stringify(bizContent)
    };
    params.sign = await alipaySign(params, resolvePrivateKey(config));
    return params;
}

/** 解析网关响应：<method>_response 的 JSON 值；并对 sign 做验签 */
async function parseGatewayResponse(
    text: string,
    responseKey: string,
    config: AlipayWebConfig
): Promise<{ data: any; verified: boolean }> {
    let data: any = {};
    try {
        data = JSON.parse(text);
    } catch {
        return { data, verified: false };
    }
    const raw = extractRawJsonValue(text, responseKey);
    const sign = data.sign;
    const publicKey = config.alipayPublicKey;
    const verified = Boolean(raw && sign && publicKey && await alipayVerify(raw, sign, publicKey));
    return { data: data[responseKey] || {}, verified };
}

export class AlipayWebPlugin implements PaymentPlugin {
    id = 'alipay_web';
    // 通道名按实际接口 alipay.trade.page.pay（电脑网站支付）命名；
    // 前台支付方式名仍只显示「支付宝」，这里仅后台通道下拉可辨识。
    name = '支付宝网页支付';
    version = '1.0.0';
    // 支付方式已合并为单一的 alipay；保留 alipay_web 以兼容旧通道/旧订单标识
    supportedTypes = ['alipay', 'alipay_web'];

    /** 下单：alipay.trade.page.pay，返回需渲染并自动提交的 HTML 表单 */
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        try {
            const cfg = config as AlipayWebConfig;
            if (!cfg.appId || !resolvePrivateKey(cfg)) {
                return { success: false, method: 'form', message: '支付宝配置不完整' };
            }

            const bizContent: Record<string, string> = {
                out_trade_no: order.tradeNo,
                total_amount: order.amount.toFixed(2),
                subject: order.subject,
                product_code: 'FAST_INSTANT_TRADE_PAY'
            };

            const params: Record<string, string> = {
                app_id: cfg.appId,
                method: 'alipay.trade.page.pay',
                format: 'JSON',
                charset: 'utf-8',
                sign_type: 'RSA2',
                timestamp: formatAlipayTimestamp(),
                version: '1.0',
                biz_content: JSON.stringify(bizContent)
            };
            // notify_url / return_url 是公共参数，必须参与签名，且与实际请求完全一致
            if (cfg.notifyUrl) params.notify_url = cfg.notifyUrl;
            if (cfg.returnUrl) params.return_url = cfg.returnUrl;
            params.sign = await alipaySign(params, resolvePrivateKey(cfg));

            // 支付宝 POST 表单：charset 必须放在 action 的 URL 查询字符串中，
            // 网关需先据此字符集解码 body 里的中文参数（subject/biz_content）才能正确验签。
            // 若 charset 只在 body 里，中文会按默认编码解码导致 invalid-signature。
            // 签名串里 charset=utf-8 仍参与（见上方 params），此处只调整提交位置。
            const { charset, ...bodyParams } = params;
            const inputs = Object.entries(bodyParams)
                .map(([k, v]) => `<input type="hidden" name="${escHtml(k)}" value="${escHtml(v)}">`)
                .join('\n');
            const actionUrl = `${gatewayOf(cfg)}?charset=${encodeURIComponent(charset)}`;
            const formHtml =
                `<form id="alipay_web_pay_form" name="punchout_form" method="post" action="${escHtml(actionUrl)}">\n` +
                `${inputs}\n` +
                `<input type="submit" value="立即支付" style="display:none">\n` +
                `</form>\n` +
                `<script>document.forms['alipay_web_pay_form'].submit();</script>`;

            return { success: true, method: 'form', formHtml };
        } catch (error: any) {
            return { success: false, method: 'form', message: error?.message || '创建支付失败' };
        }
    }

    /** 异步通知：验签 + 关键字段校验 + 排除退款/关单事件 */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        const fail = (errorCode: string, message: string): NotifyResult => ({
            success: false, tradeNo: '', outTradeNo: '', status: 'failed',
            errorCode, message, response: 'fail'
        });
        try {
            const cfg = config as AlipayWebConfig;
            const sign = payload?.sign;
            const alipayPublicKey = cfg.alipayPublicKey;
            if (!sign || !alipayPublicKey) return fail('VERIFY_NO_SIGN', '缺少验签参数');

            // 支付宝异步通知验签：按 key 排序、剔除 sign 与 sign_type、跳过空值
            const { sign: _sign, sign_type: _signType, ...notifyParams } = payload as Record<string, any>;
            const signStr = buildAlipaySignString(notifyParams);
            const ok = await alipayVerify(signStr, String(sign), alipayPublicKey);
            if (!ok) return fail('VERIFY_FAILED', '回调验签失败');

            if (cfg.appId && payload.app_id !== cfg.appId) {
                return fail('APP_ID_MISMATCH', '通知 app_id 与配置不一致');
            }
            const sellerMatches =
                (!cfg.sellerId && !cfg.sellerEmail) ||
                (cfg.sellerId && payload.seller_id === cfg.sellerId) ||
                (cfg.sellerEmail && payload.seller_email === cfg.sellerEmail);
            if (!sellerMatches) return fail('SELLER_MISMATCH', '通知收款方与配置不一致');

            // 退款 / 关单 / 分账事件不是付款成功通知
            const isPaid = PAID_STATUSES.includes(String(payload.trade_status)) &&
                !payload.out_biz_no && !payload.gmt_refund && !payload.refund_fee;

            const totalAmount = Number(payload.total_amount);
            return {
                success: true,
                // 本系统把平台订单号（orders.id）作为 alipay out_trade_no 下发，
                // 回调里的 out_trade_no 就是平台订单号，入账据此定位订单。
                tradeNo: String(payload.out_trade_no || ''),
                outTradeNo: String(payload.out_trade_no || ''),
                thirdPartyTradeNo: payload.trade_no,
                status: isPaid ? 'success' : 'pending',
                paidAmount: Number.isFinite(totalAmount) ? totalAmount : undefined,
                buyer: payload.buyer_id || payload.buyer_logon_id,
                paidAt: payload.gmt_payment,
                response: 'success'
            };
        } catch (error: any) {
            return fail('VERIFY_ERROR', error?.message || '回调处理异常');
        }
    }

    /** 交易查询：alipay.trade.query */
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus> {
        try {
            const cfg = config as AlipayWebConfig;
            const params = await buildCommonParams('alipay.trade.query', cfg, { out_trade_no: tradeNo });
            const response = await fetch(gatewayOf(cfg), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params)
            });
            const text = await response.text();
            const { data, verified } = await parseGatewayResponse(text, 'alipay_trade_query_response', cfg);
            if (!verified) return { status: 'pending' };

            const tradeStatus = String(data.trade_status || '');
            let status: OrderStatus['status'] = 'pending';
            if (PAID_STATUSES.includes(tradeStatus)) status = 'paid';
            else if (CLOSED_STATUSES.includes(tradeStatus)) status = 'closed';

            const totalAmount = Number(data.total_amount);
            return {
                status,
                thirdPartyTradeNo: data.trade_no,
                paidAmount: Number.isFinite(totalAmount) && data.total_amount !== undefined ? totalAmount : undefined,
                buyer: data.buyer_user_id,
                paidAt: data.send_pay_date
            };
        } catch {
            return { status: 'pending' };
        }
    }

    /** 退款：alipay.trade.refund */
    async refund(order: OrderInfo, amount: number, config: PluginConfig): Promise<RefundResult> {
        try {
            const cfg = config as AlipayWebConfig;
            const refundNo = generateRefundNo().replace(/-/g, '');
            const params = await buildCommonParams('alipay.trade.refund', cfg, {
                out_trade_no: order.tradeNo,
                refund_amount: amount.toFixed(2),
                out_request_no: refundNo
            });
            const response = await fetch(gatewayOf(cfg), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params)
            });
            const text = await response.text();
            const { data, verified } = await parseGatewayResponse(text, 'alipay_trade_refund_response', cfg);
            if (!verified) return { success: false, message: '退款响应验签失败' };
            if (String(data.code) === '10000') {
                return { success: true, refundNo, thirdPartyRefundNo: data.trade_no };
            }
            return { success: false, message: data.sub_msg || data.msg || '退款失败' };
        } catch (error: any) {
            return { success: false, message: error?.message || '退款失败' };
        }
    }

    /** 退款查询：alipay.trade.fastpay.refund.query */
    async queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus> {
        try {
            const cfg = config as AlipayWebConfig;
            const params = await buildCommonParams('alipay.trade.fastpay.refund.query', cfg, {
                out_request_no: refundNo
            });
            const response = await fetch(gatewayOf(cfg), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params)
            });
            const text = await response.text();
            const { data, verified } = await parseGatewayResponse(text, 'alipay_trade_fastpay_refund_query_response', cfg);
            if (!verified) return { status: 'processing' };
            let status: RefundStatus['status'] = 'processing';
            if (data.refund_status === 'REFUND_SUCCESS') status = 'success';
            else if (data.refund_status === 'REFUND_FAIL') status = 'failed';
            const refundAmount = Number(data.refund_amount);
            return {
                status,
                amount: Number.isFinite(refundAmount) && data.refund_amount !== undefined ? refundAmount : undefined,
                refundedAt: data.refund_time,
                message: data.refund_error_msg
            };
        } catch {
            return { status: 'processing' };
        }
    }

    /** 关闭未付款交易：alipay.trade.close（可选接口，由关单路由调用） */
    async closeOrder(tradeNo: string, config: PluginConfig): Promise<{ success: boolean; message?: string }> {
        try {
            const cfg = config as AlipayWebConfig;
            const params = await buildCommonParams('alipay.trade.close', cfg, { out_trade_no: tradeNo });
            const response = await fetch(gatewayOf(cfg), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params)
            });
            const text = await response.text();
            const { data, verified } = await parseGatewayResponse(text, 'alipay_trade_close_response', cfg);
            if (!verified) return { success: false, message: '关单响应验签失败' };
            if (String(data.code) === '10000' || data.trade_status === 'TRADE_CLOSED') {
                return { success: true };
            }
            return { success: false, message: data.sub_msg || data.msg || '关闭交易失败' };
        } catch (error: any) {
            return { success: false, message: error?.message || '关闭交易异常' };
        }
    }
}
