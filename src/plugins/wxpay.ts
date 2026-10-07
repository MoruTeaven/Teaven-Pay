/**
 * 微信支付插件
 */

import {
    PaymentPlugin,
    OrderInfo,
    PluginConfig,
    PaymentResult,
    NotifyResult,
    OrderStatus,
    RefundResult,
    RefundStatus,
    JsapiParams
} from '../types/plugin';
import { rsaSign, generateNonce, x509CertToPublicKey, x509CertValidity } from '../utils/crypto';
import { generateRefundNo } from '../utils/uuid';

/** 微信 v3 平台证书（含 DER 解析出的有效期，用于到期自动刷新） */
interface PlatformCert {
    serial: string;
    pem: string;
    notBefore: number;
    notAfter: number;
}

/** 平台证书缓存键（system_config 表） */
const WX_CERT_CACHE_KEY = 'wxpay:platform_certs';

/** 证书到期前提前刷新窗口（7 天） */
const WX_CERT_REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

export class WxpayPlugin implements PaymentPlugin {
    id = 'wxpay';
    name = '微信支付';
    version = '1.0.0';
    supportedTypes = ['wxpay'];
    
    private apiBase = 'https://api.mch.weixin.qq.com';

    /** 平台证书进程内缓存（isolate 生命周期内有效） */
    private certCache: { list: PlatformCert[]; expiresAt: number } | null = null;
    
    /**
     * 创建支付订单
     */
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        try {
            const nonce = generateNonce();
            const timestamp = Math.floor(Date.now() / 1000).toString();
            
            // 构建请求参数
            const params = {
                appid: config.appId,
                mchid: config.mchId,
                description: order.subject,
                out_trade_no: order.tradeNo,
                notify_url: config.notifyUrl,
                amount: {
                    total: Math.round(order.amount * 100), // 转为分
                    currency: 'CNY'
                },
                payer: {
                    openid: order.buyer || ''
                }
            };
            
            // 生成签名
            const signData = {
                method: 'POST',
                url: '/v3/pay/transactions/jsapi',
                timestamp: timestamp,
                nonce: nonce,
                body: JSON.stringify(params)
            };
            
            const signature = await rsaSign(signData, config.appSecret);
            const Authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.serialNo}"`;
            
            // 调用统一下单接口
            const response = await fetch(`${this.apiBase}/v3/pay/transactions/jsapi`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': Authorization,
                    'Accept': 'application/json'
                },
                body: JSON.stringify(params)
            });
            
            const data: any = await response.json();
            
            if (data.prepay_id) {
                // 生成 JSAPI 参数
                const jsapiParams = await this.generateJsapiParams(
                    config.appId,
                    data.prepay_id,
                    config.appSecret
                );
                
                return {
                    success: true,
                    method: 'jsapi',
                    jsapiParams
                };
            } else {
                return {
                    success: false,
                    message: data.message || '创建订单失败'
                };
            }
        } catch (error: any) {
            return {
                success: false,
                message: error.message || '创建支付失败'
            };
        }
    }
    
    /**
     * 生成 JSAPI 参数
     */
    private async generateJsapiParams(appId: string, prepayId: string, privateKey: string): Promise<JsapiParams> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = generateNonce();
        const packageStr = `prepay_id=${prepayId}`;
        
        const signStr = `${appId}\n${timestamp}\n${nonce}\n${packageStr}\n`;
        const paySign = await rsaSign(signStr, privateKey);
        
        return {
            appId,
            timeStamp: timestamp,
            nonceStr: nonce,
            package: packageStr,
            signType: 'RSA',
            paySign
        };
    }
    
    /**
     * 验证支付回调（微信支付 APIv3）
     *
     * 微信真实签名由「平台证书私钥 RSA-SHA256」签出，待签字符串为
     * timestamp + "\n" + nonce + "\n" + body + "\n"（换行分隔，非点号；
     * body 必须是原始报文，不能重新序列化）。验签公钥来自
     * GET /v3/certificates 下发的平台证书，缓存于 system_config 表。
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        let tradeNo = '';
        let outTradeNo = '';
        try {
            const headers = payload._headers || {};
            const signature = (headers['wechatpay-signature'] || '').trim();
            const timestamp = (headers['wechatpay-timestamp'] || '').trim();
            const nonce = (headers['wechatpay-nonce'] || '').trim();
            const serial = (headers['wechatpay-serial'] || '').trim();
            const rawBody = typeof payload._rawBody === 'string' ? payload._rawBody : '';

            const fail = (errorCode: string, message: string): NotifyResult => ({
                success: false,
                tradeNo,
                outTradeNo,
                status: 'failed',
                errorCode,
                message,
                response: JSON.stringify({ code: 'FAIL', message })
            });

            if (!signature || !timestamp || !nonce || !rawBody) {
                return fail('PARAM_ERROR', '缺少签名请求头或请求体');
            }

            // 时间戳漂移校验（微信建议 5 分钟内）
            const tsSec = Number(timestamp);
            if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
                return fail('TIMESTAMP_EXPIRED', '回调时间戳超出允许范围');
            }

            // 取平台证书：按 Wechatpay-Serial 命中，失败则回退任一有效证书
            const certs = await this.getPlatformCertificates(config, config.db as D1Database | undefined);
            if (!certs.length) {
                return fail('CERT_UNAVAILABLE', '平台证书获取失败');
            }
            const cert = certs.find((x) => x.serial === serial) || certs[0];

            const message = timestamp + '\n' + nonce + '\n' + rawBody + '\n';
            const pubKey = await x509CertToPublicKey(cert.pem);
            const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
            const verified = await crypto.subtle.verify(
                { name: 'RSASSA-PKCS1-v1_5' },
                pubKey,
                sigBytes,
                new TextEncoder().encode(message)
            );
            if (!verified) {
                return fail('SIGNATURE_INVALID', '回调签名验证失败');
            }

            // ===== 以下为 resource AES-256-GCM 解密（保留原逻辑） =====
            const resource = payload.resource || {};
            const ciphertext = resource.ciphertext || '';
            const aesNonce = resource.nonce || '';
            const associatedData = resource.associated_data || '';
            if (!ciphertext) {
                return fail('RESOURCE_MISSING', '回调资源数据缺失');
            }

            const apiV3Key = (config.apiKey || '').padEnd(32, '0').slice(0, 32);
            const aesKey = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(apiV3Key),
                { name: 'AES-GCM' },
                false,
                ['decrypt']
            );
            const decrypted = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: new TextEncoder().encode(aesNonce),
                    additionalData: new TextEncoder().encode(associatedData),
                    tagLength: 128
                },
                aesKey,
                Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0))
            );
            const data = JSON.parse(new TextDecoder().decode(decrypted));

            tradeNo = data.out_trade_no || '';
            outTradeNo = data.out_trade_no || '';

            if (data.trade_state !== 'SUCCESS') {
                return {
                    success: true,
                    tradeNo,
                    outTradeNo,
                    thirdPartyTradeNo: data.transaction_id,
                    status: 'pending',
                    paidAmount: paidAmountFromCents(data.amount),
                    buyer: data.payer?.openid,
                    response: JSON.stringify({ code: 'SUCCESS', message: 'OK' })
                };
            }

            return {
                success: true,
                tradeNo,
                outTradeNo,
                thirdPartyTradeNo: data.transaction_id,
                status: 'success',
                paidAmount: paidAmountFromCents(data.amount),
                buyer: data.payer?.openid,
                paidAt: data.success_time,
                response: JSON.stringify({ code: 'SUCCESS', message: 'OK' })
            };
        } catch (error) {
            console.error('[Wxpay] verifyNotify error:', error);
            return {
                success: false,
                tradeNo,
                outTradeNo,
                status: 'failed',
                errorCode: 'DECRYPT_FAILED',
                message: '回调数据解密失败',
                response: JSON.stringify({ code: 'FAIL', message: '回调数据解密失败' })
            };
        }
    }

    /**
     * 获取平台证书列表：内存/DB 缓存优先，缺失或临近过期时重新下载
     */
    private async getPlatformCertificates(config: PluginConfig, db?: D1Database): Promise<PlatformCert[]> {
        const now = Date.now();
        if (this.certCache && this.certCache.expiresAt - now > WX_CERT_REFRESH_AHEAD_MS) {
            return this.certCache.list;
        }

        if (db) {
            try {
                const row = await db
                    .prepare('SELECT value FROM system_config WHERE key = ?')
                    .bind(WX_CERT_CACHE_KEY)
                    .first<{ value: string }>();
                if (row?.value) {
                    const cached = JSON.parse(row.value) as { list: PlatformCert[]; expiresAt: number };
                    if (cached.expiresAt - now > WX_CERT_REFRESH_AHEAD_MS && cached.list?.length) {
                        this.certCache = cached;
                        return cached.list;
                    }
                }
            } catch (error) {
                console.error('[Wxpay] read cert cache error:', error);
            }
        }

        const list = await this.downloadPlatformCertificates(config);
        if (!list.length) {
            return this.certCache?.list || [];
        }

        // 有效期取所有证书中最早的过期时间，保证任何一张临近过期都会触发重下
        const expiresAt = Math.min(...list.map((c) => c.notAfter));
        const entry = { list, expiresAt };
        this.certCache = entry;

        if (db) {
            try {
                await db
                    .prepare(
                        "INSERT INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, datetime('now')) " +
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
                    )
                    .bind(WX_CERT_CACHE_KEY, JSON.stringify(entry), '微信支付平台证书缓存（自动维护，勿手改）')
                    .run();
            } catch (error) {
                console.error('[Wxpay] write cert cache error:', error);
            }
        }

        return list;
    }

    /**
     * GET /v3/certificates 下载并解密平台证书
     */
    private async downloadPlatformCertificates(config: PluginConfig): Promise<PlatformCert[]> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = generateNonce();
        const url = '/v3/certificates';

        const signature = await rsaSign(
            { method: 'GET', url, timestamp, nonce, body: '' },
            config.appSecret
        );

        const authorization =
            'WECHATPAY2-SHA256-RSA2048 mchid="' + config.mchId +
            '",nonce_str="' + nonce +
            '",timestamp="' + timestamp +
            '",signature="' + signature +
            '",serial_no="' + config.serialNo + '"';

        const response = await fetch(this.apiBase + url, {
            method: 'GET',
            headers: { Authorization: authorization, Accept: 'application/json' }
        });

        if (!response.ok) {
            console.error('[Wxpay] download certificates failed: HTTP ' + response.status);
            return [];
        }

        const data: any = await response.json();
        const apiV3Key = (config.apiKey || '').padEnd(32, '0').slice(0, 32);
        const aesKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(apiV3Key),
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );

        const out: PlatformCert[] = [];
        for (const item of data.data || []) {
            try {
                const enc = item.encrypt_certificate || {};
                const decrypted = await crypto.subtle.decrypt(
                    {
                        name: 'AES-GCM',
                        iv: new TextEncoder().encode(enc.nonce || ''),
                        additionalData: new TextEncoder().encode(enc.associated_data || ''),
                        tagLength: 128
                    },
                    aesKey,
                    Uint8Array.from(atob(enc.ciphertext || ''), (c) => c.charCodeAt(0))
                );
                const pem = new TextDecoder().decode(decrypted);
                const { notBefore, notAfter } = x509CertValidity(pem);
                out.push({ serial: item.serial_no, pem, notBefore, notAfter });
            } catch (error) {
                console.error('[Wxpay] decrypt platform certificate error:', error);
            }
        }
        return out;
    }

    /**
     * 查询订单状态
     */
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus> {
        try {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonce = generateNonce();
            const url = `/v3/pay/transactions/out-trade-no/${tradeNo}?mchid=${config.mchId}`;
            
            const signData = {
                method: 'GET',
                url: url,
                timestamp: timestamp,
                nonce: nonce,
                body: ''
            };
            
            const signature = await rsaSign(signData, config.appSecret);
            const Authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.serialNo}"`;
            
            const response = await fetch(`${this.apiBase}${url}`, {
                method: 'GET',
                headers: {
                    'Authorization': Authorization,
                    'Accept': 'application/json'
                }
            });
            
            const data: any = await response.json();
            
            let status: OrderStatus['status'] = 'pending';
            if (data.trade_state === 'SUCCESS') {
                status = 'paid';
            } else if (data.trade_state === 'CLOSED') {
                status = 'closed';
            } else if (data.trade_state === 'REFUND') {
                status = 'refunded';
            }
            
            return {
                status,
                thirdPartyTradeNo: data.transaction_id,
                paidAmount: paidAmountFromCents(data.amount),
                buyer: data.payer?.openid,
                paidAt: data.success_time
            };
        } catch (error) {
            return {
                status: 'pending'
            };
        }
    }
    
    /**
     * 申请退款
     */
    async refund(order: OrderInfo, amount: number, config: PluginConfig): Promise<RefundResult> {
        try {
            // 微信 out_refund_no 字符集有限制，去掉 UUID 连字符
    const refundNo = generateRefundNo().replace(/-/g, '');
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonce = generateNonce();
            
            const params = {
                out_trade_no: order.tradeNo,
                out_refund_no: refundNo,
                amount: {
                    refund: Math.round(amount * 100),
                    total: Math.round(order.amount * 100),
                    currency: 'CNY'
                }
            };
            
            const signData = {
                method: 'POST',
                url: '/v3/refund/domestic/refunds',
                timestamp: timestamp,
                nonce: nonce,
                body: JSON.stringify(params)
            };
            
            const signature = await rsaSign(signData, config.appSecret);
            const Authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.serialNo}"`;
            
            const response = await fetch(`${this.apiBase}/v3/refund/domestic/refunds`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': Authorization,
                    'Accept': 'application/json'
                },
                body: JSON.stringify(params)
            });
            
            const data: any = await response.json();
            
            if (data.refund_id) {
                return {
                    success: true,
                    refundNo,
                    thirdPartyRefundNo: data.refund_id
                };
            } else {
                return {
                    success: false,
                    message: data.message || '退款失败'
                };
            }
        } catch (error: any) {
            return {
                success: false,
                message: error.message || '退款失败'
            };
        }
    }
    
    /**
     * 查询退款状态
     */
    async queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus> {
        try {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonce = generateNonce();
            const url = `/v3/refund/domestic/refunds/${refundNo}`;
            
            const signData = {
                method: 'GET',
                url: url,
                timestamp: timestamp,
                nonce: nonce,
                body: ''
            };
            
            const signature = await rsaSign(signData, config.appSecret);
            const Authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.serialNo}"`;
            
            const response = await fetch(`${this.apiBase}${url}`, {
                method: 'GET',
                headers: {
                    'Authorization': Authorization,
                    'Accept': 'application/json'
                }
            });
            
            const data: any = await response.json();
            
            let status: RefundStatus['status'] = 'processing';
            if (data.status === 'SUCCESS') {
                status = 'success';
            } else if (data.status === 'ABNORMAL' || data.status === 'CLOSED') {
                status = 'failed';
            }
            
            return {
                status,
                amount: data.amount?.refund ? data.amount.refund / 100 : undefined
            };
        } catch (error) {
            return {
                status: 'processing'
            };
        }
    }
}

/**
 * 微信支付金额字段单位为「分」，统一换算成元。
 * 缺失或非法时返回 undefined，由入账层按「无法核对」拒绝入账。
 */
function paidAmountFromCents(amount: any): number | undefined {
    if (!amount || typeof amount !== 'object') return undefined;
    const cents = Number(amount.payer_total ?? amount.total);
    if (!Number.isFinite(cents) || cents <= 0) return undefined;
    return Math.round(cents) / 100;
}

