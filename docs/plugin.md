# Teaven Pay 插件开发指南

## 概述

Teaven Pay 采用插件化架构支持多种支付方式。每个支付方式对应一个插件，插件需要实现统一的接口规范。

---

## 插件接口

### 基础接口

```typescript
// types/plugin.ts

export interface PaymentPlugin {
    /** 插件唯一标识 */
    id: string;
    
    /** 插件显示名称 */
    name: string;
    
    /** 插件版本 */
    version: string;
    
    /** 支持的支付方式列表 */
    supportedTypes: string[];
    
    /** 
     * 创建支付订单
     * @param order 订单信息
     * @param config 插件配置
     * @returns 支付结果
     */
    createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult>;
    
    /**
     * 验证支付回调
     * @param payload 回调数据
     * @param config 插件配置
     * @returns 验证结果
     */
    verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult>;
    
    /**
     * 查询订单状态
     * @param tradeNo 平台订单号
     * @param config 插件配置
     * @returns 订单状态
     */
    queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus>;
    
    /**
     * 申请退款
     * @param order 订单信息
     * @param amount 退款金额
     * @param config 插件配置
     * @returns 退款结果
     */
    refund(order: OrderInfo, amount: number, config: PluginConfig): Promise<RefundResult>;
    
    /**
     * 查询退款状态
     * @param refundNo 退款单号
     * @param config 插件配置
     * @returns 退款状态
     */
    queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus>;
}
```

### 数据类型

```typescript
// types/order.ts

export interface OrderInfo {
    /** 平台订单号 */
    tradeNo: string;
    
    /** 商户订单号 */
    outTradeNo: string;
    
    /** 订单金额 (元) */
    amount: number;
    
    /** 实际支付金额 (元) */
    actualAmount: number;
    
    /** 商品名称 */
    subject: string;
    
    /** 商品描述 */
    body?: string;
    
    /** 自定义参数 */
    param?: string;
    
    /** 买家信息 */
    buyer?: string;
    
    /** 客户端 IP */
    clientIp: string;
    
    /** 创建时间 */
    createdAt: string;
    
    /** 过期时间 */
    expireAt?: string;
}

export interface PluginConfig {
    /** 应用 ID / 商户号 */
    appId: string;
    
    /** 应用密钥 / 商户密钥 */
    appSecret: string;
    
    /** 其他配置 */
    [key: string]: any;
}

export interface PaymentResult {
    /** 是否成功 */
    success: boolean;
    
    /** 支付方式: qrcode/jump/jsapi/form */
    method: 'qrcode' | 'jump' | 'jsapi' | 'form';
    
    /** 支付链接 (method=jump) */
    payUrl?: string;
    
    /** 二维码内容 (method=qrcode) */
    qrcode?: string;
    
    /** 二维码图片 URL */
    qrcodeUrl?: string;
    
    /** JSAPI 参数 (method=jsapi) */
    jsapiParams?: JsapiParams;
    
    /** 表单 HTML (method=form) */
    formHtml?: string;
    
    /** 错误信息 */
    message?: string;
}

export interface JsapiParams {
    appId: string;
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: string;
    paySign: string;
}

export interface NotifyResult {
    /** 验证是否成功 */
    success: boolean;
    
    /** 平台订单号 */
    tradeNo: string;
    
    /** 商户订单号 */
    outTradeNo: string;
    
    /** 第三方交易号 */
    thirdPartyTradeNo?: string;
    
    /** 支付状态 */
    status: 'success' | 'failed' | 'pending';
    
    /** 买家信息 */
    buyer?: string;
    
    /** 支付时间 */
    paidAt?: string;
    
    /** 需要返回给第三方的响应 */
    response?: string;
}

export interface OrderStatus {
    /** 订单状态 */
    status: 'pending' | 'paid' | 'closed' | 'refunded';
    
    /** 第三方交易号 */
    thirdPartyTradeNo?: string;
    
    /** 买家信息 */
    buyer?: string;
    
    /** 支付时间 */
    paidAt?: string;
}

export interface RefundResult {
    /** 是否成功 */
    success: boolean;
    
    /** 退款单号 */
    refundNo?: string;
    
    /** 第三方退款号 */
    thirdPartyRefundNo?: string;
    
    /** 错误信息 */
    message?: string;
}

export interface RefundStatus {
    /** 退款状态 */
    status: 'processing' | 'success' | 'failed';
    
    /** 退款金额 */
    amount?: number;
    
    /** 退款时间 */
    refundedAt?: string;
}
```

---

## 插件开发步骤

### 1. 创建插件文件

在 `workers/src/plugins/` 目录下创建新的插件文件:

```typescript
// workers/src/plugins/my-payment.ts

import { PaymentPlugin, OrderInfo, PluginConfig, PaymentResult, NotifyResult, OrderStatus, RefundResult, RefundStatus } from '../types/plugin';

export class MyPaymentPlugin implements PaymentPlugin {
    id = 'my-payment';
    name = '我的支付';
    version = '1.0.0';
    supportedTypes = ['mypay'];
    
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        // 实现创建支付逻辑
    }
    
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        // 实现回调验证逻辑
    }
    
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus> {
        // 实现订单查询逻辑
    }
    
    async refund(order: OrderInfo, amount: number, config: PluginConfig): Promise<RefundResult> {
        // 实现退款逻辑
    }
    
    async queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus> {
        // 实现退款查询逻辑
    }
}
```

### 2. 注册插件

在 `workers/src/plugins/index.ts` 中注册插件:

```typescript
// workers/src/plugins/index.ts

import { AlipayPlugin } from './alipay';
import { WxpayPlugin } from './wxpay';
import { MyPaymentPlugin } from './my-payment';

const plugins: Record<string, any> = {
    'alipay': AlipayPlugin,
    'wxpay': WxpayPlugin,
    'my-payment': MyPaymentPlugin,
};

export function getPlugin(id: string) {
    const PluginClass = plugins[id];
    if (!PluginClass) {
        throw new Error(`Plugin ${id} not found`);
    }
    return new PluginClass();
}
```

### 3. 配置数据库

在数据库中添加支付方式和通道配置:

```sql
-- 添加支付方式
INSERT INTO payment_types (id, name, display_name, status) 
VALUES ('xxx', 'mypay', '我的支付', 1);

-- 添加支付通道
INSERT INTO channels (id, payment_type_id, name, plugin, config, fee_rate, status)
VALUES ('xxx', 'xxx', '我的支付通道', 'my-payment', '{}', 0.6, 1);
```

---

## 完整示例: 支付宝插件

```typescript
// workers/src/plugins/alipay.ts

import { PaymentPlugin, OrderInfo, PluginConfig, PaymentResult, NotifyResult, OrderStatus, RefundResult, RefundStatus } from '../types/plugin';
import { generateSign, verifySign, rsaSign, rsaVerify } from '../utils/crypto';

export class AlipayPlugin implements PaymentPlugin {
    id = 'alipay';
    name = '支付宝';
    version = '1.0.0';
    supportedTypes = ['alipay'];
    
    /**
     * 创建支付订单
     */
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        try {
            // 构建请求参数
            const bizContent = {
                out_trade_no: order.tradeNo,
                total_amount: order.amount.toFixed(2),
                subject: order.subject,
                body: order.body || '',
                product_code: 'QUICK_MSECURITY_PAY',
                timeout_express: '30m'
            };
            
            const params = {
                app_id: config.appId,
                method: 'alipay.trade.app.pay',
                charset: 'utf-8',
                sign_type: 'RSA2',
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                version: '1.0',
                biz_content: JSON.stringify(bizContent)
            };
            
            // 生成签名
            params['sign'] = rsaSign(params, config.privateKey);
            
            // 构建支付参数
            const payParams = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                payParams.append(key, value);
            }
            
            return {
                success: true,
                method: 'jump',
                payUrl: `https://openapi.alipay.com/gateway.do?${payParams.toString()}`
            };
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }
    
    /**
     * 验证支付回调
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        try {
            // 验证签名
            const sign = payload.sign;
            const signType = payload.sign_type;
            
            // 构建待验签字符串
            const params = { ...payload };
            delete params.sign;
            delete params.sign_type;
            
            const isValid = rsaVerify(params, sign, config.alipayPublicKey, signType);
            
            if (!isValid) {
                return {
                    success: false,
                    tradeNo: '',
                    outTradeNo: '',
                    status: 'failed'
                };
            }
            
            // 解析通知内容
            const notifyData = JSON.parse(payload.biz_content || '{}');
            
            return {
                success: true,
                tradeNo: notifyData.passback_params || '',
                outTradeNo: payload.out_trade_no || '',
                thirdPartyTradeNo: payload.trade_no,
                status: payload.trade_status === 'TRADE_SUCCESS' ? 'success' : 'pending',
                buyer: payload.buyer_id,
                paidAt: payload.gmt_payment,
                response: 'success'
            };
        } catch (error) {
            return {
                success: false,
                tradeNo: '',
                outTradeNo: '',
                status: 'failed'
            };
        }
    }
    
    /**
     * 查询订单状态
     */
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus> {
        try {
            const params = {
                app_id: config.appId,
                method: 'alipay.trade.query',
                charset: 'utf-8',
                sign_type: 'RSA2',
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                version: '1.0',
                biz_content: JSON.stringify({
                    out_trade_no: tradeNo
                })
            };
            
            params['sign'] = rsaSign(params, config.privateKey);
            
            const response = await fetch('https://openapi.alipay.com/gateway.do', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            
            const data = await response.json();
            const tradeStatus = data.alipay_trade_query_response?.trade_status;
            
            let status: OrderStatus['status'] = 'pending';
            if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
                status = 'paid';
            } else if (tradeStatus === 'TRADE_CLOSED') {
                status = 'closed';
            }
            
            return {
                status,
                thirdPartyTradeNo: data.alipay_trade_query_response?.trade_no,
                buyer: data.alipay_trade_query_response?.buyer_user_id,
                paidAt: data.alipay_trade_query_response?.send_pay_date
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
            const refundNo = `REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            const params = {
                app_id: config.appId,
                method: 'alipay.trade.refund',
                charset: 'utf-8',
                sign_type: 'RSA2',
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                version: '1.0',
                biz_content: JSON.stringify({
                    out_trade_no: order.tradeNo,
                    refund_amount: amount.toFixed(2),
                    out_request_no: refundNo
                })
            };
            
            params['sign'] = rsaSign(params, config.privateKey);
            
            const response = await fetch('https://openapi.alipay.com/gateway.do', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            
            const data = await response.json();
            const refundResponse = data.alipay_trade_refund_response;
            
            if (refundResponse?.code === '10000') {
                return {
                    success: true,
                    refundNo,
                    thirdPartyRefundNo: refundResponse.trade_no
                };
            } else {
                return {
                    success: false,
                    message: refundResponse?.sub_msg || '退款失败'
                };
            }
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }
    
    /**
     * 查询退款状态
     */
    async queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus> {
        try {
            const params = {
                app_id: config.appId,
                method: 'alipay.trade.fastpay.refund.query',
                charset: 'utf-8',
                sign_type: 'RSA2',
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                version: '1.0',
                biz_content: JSON.stringify({
                    out_request_no: refundNo
                })
            };
            
            params['sign'] = rsaSign(params, config.privateKey);
            
            const response = await fetch('https://openapi.alipay.com/gateway.do', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            
            const data = await response.json();
            const refundStatus = data.alipay_trade_fastpay_refund_query_response?.refund_status;
            
            let status: RefundStatus['status'] = 'processing';
            if (refundStatus === 'REFUND_SUCCESS') {
                status = 'success';
            } else if (refundStatus === 'REFUND_FAIL') {
                status = 'failed';
            }
            
            return {
                status,
                amount: parseFloat(data.alipay_trade_fastpay_refund_query_response?.refund_amount || '0')
            };
        } catch (error) {
            return {
                status: 'processing'
            };
        }
    }
}
```

---

## 微信支付插件示例

```typescript
// workers/src/plugins/wxpay.ts

import { PaymentPlugin, OrderInfo, PluginConfig, PaymentResult, NotifyResult, OrderStatus, RefundResult, RefundStatus } from '../types/plugin';
import { generateSign, verifySign, hmacSha256, generateNonce } from '../utils/crypto';

export class WxpayPlugin implements PaymentPlugin {
    id = 'wxpay';
    name = '微信支付';
    version = '1.0.0';
    supportedTypes = ['wxpay'];
    
    private apiBase = 'https://api.mch.weixin.qq.com';
    
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
            
            const signature = rsaSign(signData, config.privateKey);
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
            
            const data = await response.json();
            
            if (data.prepay_id) {
                // 生成 JSAPI 参数
                const jsapiParams = this.generateJsapiParams(
                    config.appId,
                    data.prepay_id,
                    config.privateKey
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
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }
    
    /**
     * 生成 JSAPI 参数
     */
    private generateJsapiParams(appId: string, prepayId: string, privateKey: string): JsapiParams {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = generateNonce();
        const packageStr = `prepay_id=${prepayId}`;
        
        const signStr = `${appId}\n${timestamp}\n${nonce}\n${packageStr}\n`;
        const paySign = rsaSign(signStr, privateKey);
        
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
     * 验证支付回调
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        try {
            // 验证签名
            const timestamp = payload.timestamp;
            const nonce = payload.nonce;
            const signature = payload.signature;
            const body = payload.resource;
            
            const signStr = `${timestamp}\n${nonce}\n${JSON.stringify(body)}\n`;
            const isValid = rsaVerify(signStr, signature, config.wxPublicKey);
            
            if (!isValid) {
                return {
                    success: false,
                    tradeNo: '',
                    outTradeNo: '',
                    status: 'failed'
                };
            }
            
            // 解密通知内容
            const decryptedData = this.decryptResource(body, config.apiKey);
            
            return {
                success: true,
                tradeNo: decryptedData.out_trade_no,
                outTradeNo: decryptedData.out_trade_no,
                thirdPartyTradeNo: decryptedData.transaction_id,
                status: decryptedData.trade_state === 'SUCCESS' ? 'success' : 'pending',
                buyer: decryptedData.payer?.openid,
                paidAt: decryptedData.success_time,
                response: JSON.stringify({ code: 'SUCCESS', message: 'OK' })
            };
        } catch (error) {
            return {
                success: false,
                tradeNo: '',
                outTradeNo: '',
                status: 'failed'
            };
        }
    }
    
    /**
     * 解密回调资源
     */
    private decryptResource(resource: any, apiKey: string): any {
        const { ciphertext, nonce, associated_data } = resource;
        
        // AES-256-GCM 解密
        const key = Buffer.from(apiKey, 'utf-8');
        const iv = Buffer.from(nonce, 'utf-8');
        const authTag = Buffer.from(ciphertext.slice(-32), 'base64');
        const encryptedData = Buffer.from(ciphertext.slice(0, -32), 'base64');
        
        // 使用 Web Crypto API 解密
        // ... 实现解密逻辑
        
        return JSON.parse(decryptedData);
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
            
            const signature = rsaSign(signData, config.privateKey);
            const Authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.serialNo}"`;
            
            const response = await fetch(`${this.apiBase}${url}`, {
                method: 'GET',
                headers: {
                    'Authorization': Authorization,
                    'Accept': 'application/json'
                }
            });
            
            const data = await response.json();
            
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
            const refundNo = `REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
            
            const signature = rsaSign(signData, config.privateKey);
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
            
            const data = await response.json();
            
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
        } catch (error) {
            return {
                success: false,
                message: error.message
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
            
            const signature = rsaSign(signData, config.privateKey);
            const Authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.serialNo}"`;
            
            const response = await fetch(`${this.apiBase}${url}`, {
                method: 'GET',
                headers: {
                    'Authorization': Authorization,
                    'Accept': 'application/json'
                }
            });
            
            const data = await response.json();
            
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
```

---

## 工具函数

### crypto.ts

```typescript
// workers/src/utils/crypto.ts

/**
 * 生成 UUID v7
 */
export function generateUUIDv7(): string {
    const timestamp = Date.now();
    const random = crypto.getRandomValues(new Uint8Array(10));
    
    const hex = timestamp.toString(16).padStart(12, '0') +
        Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');
    
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        '7' + hex.slice(13, 16),  // version 7
        ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hex.slice(18, 20),
        hex.slice(20, 32)
    ].join('-');
}

/**
 * 生成随机字符串
 */
export function generateNonce(length: number = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const random = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(random).map(b => chars[b % chars.length]).join('');
}

/**
 * MD5 哈希
 */
export async function md5(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('MD5', data);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * HMAC-SHA256
 */
export async function hmacSha256(key: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);
    
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * RSA 签名
 */
export async function rsaSign(params: any, privateKey: string): Promise<string> {
    // 构建待签名字符串
    let signStr: string;
    if (typeof params === 'string') {
        signStr = params;
    } else {
        const sortedKeys = Object.keys(params).sort();
        const parts = [];
        for (const key of sortedKeys) {
            if (params[key] !== '' && params[key] !== undefined && key !== 'sign') {
                parts.push(`${key}=${params[key]}`);
            }
        }
        signStr = parts.join('&');
    }
    
    // 导入私钥
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    const pemContents = privateKey
        .replace(pemHeader, '')
        .replace(pemFooter, '')
        .replace(/\s/g, '');
    
    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    
    const key = await crypto.subtle.importKey(
        'pkcs8',
        binaryDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
    
    // 签名
    const encoder = new TextEncoder();
    const data = encoder.encode(signStr);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
    
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * RSA 验签
 */
export async function rsaVerify(params: any, signature: string, publicKey: string): Promise<boolean> {
    try {
        // 构建待验签字符串
        let signStr: string;
        if (typeof params === 'string') {
            signStr = params;
        } else {
            const sortedKeys = Object.keys(params).sort();
            const parts = [];
            for (const key of sortedKeys) {
                if (params[key] !== '' && params[key] !== undefined && key !== 'sign') {
                    parts.push(`${key}=${params[key]}`);
                }
            }
            signStr = parts.join('&');
        }
        
        // 导入公钥
        const pemHeader = '-----BEGIN PUBLIC KEY-----';
        const pemFooter = '-----END PUBLIC KEY-----';
        const pemContents = publicKey
            .replace(pemHeader, '')
            .replace(pemFooter, '')
            .replace(/\s/g, '');
        
        const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
        
        const key = await crypto.subtle.importKey(
            'spki',
            binaryDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        
        // 验签
        const encoder = new TextEncoder();
        const data = encoder.encode(signStr);
        const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        
        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, data);
    } catch (error) {
        return false;
    }
}

/**
 * 生成签名 (MD5)
 */
export function generateSign(params: Record<string, any>, apiKey: string): string {
    const sortedKeys = Object.keys(params).sort();
    let signStr = '';
    
    for (const key of sortedKeys) {
        if (params[key] !== '' && params[key] !== undefined && key !== 'sign' && key !== 'sign_type') {
            signStr += key + '=' + params[key] + '&';
        }
    }
    
    signStr = signStr.slice(0, -1);
    signStr = apiKey + signStr + apiKey;
    
    return md5(signStr).toLowerCase();
}

/**
 * 验证签名 (MD5)
 */
export function verifySign(params: Record<string, any>, apiKey: string, sign: string): boolean {
    const expectedSign = generateSign(params, apiKey);
    return expectedSign === sign.toLowerCase();
}
```

---

## 测试插件

### 单元测试

```typescript
// tests/plugins/alipay.test.ts

import { AlipayPlugin } from '../../src/plugins/alipay';

describe('AlipayPlugin', () => {
    let plugin: AlipayPlugin;
    
    beforeEach(() => {
        plugin = new AlipayPlugin();
    });
    
    test('should have correct id and name', () => {
        expect(plugin.id).toBe('alipay');
        expect(plugin.name).toBe('支付宝');
    });
    
    test('should create payment successfully', async () => {
        const order = {
            tradeNo: '202606221234567890',
            outTradeNo: 'ORDER_123456',
            amount: 10.00,
            actualAmount: 10.00,
            subject: '测试商品',
            clientIp: '127.0.0.1',
            createdAt: new Date().toISOString()
        };
        
        const config = {
            appId: 'test_app_id',
            appSecret: 'test_app_secret',
            privateKey: 'test_private_key'
        };
        
        const result = await plugin.createPayment(order, config);
        
        expect(result.success).toBe(true);
        expect(result.method).toBe('jump');
        expect(result.payUrl).toBeDefined();
    });
    
    test('should verify notify correctly', async () => {
        // ... 测试回调验证
    });
});
```

### 集成测试

```typescript
// tests/integration/payment.test.ts

describe('Payment Integration', () => {
    test('should complete full payment flow', async () => {
        // 1. 创建订单
        const createResponse = await fetch('http://localhost:8787/api.php?act=submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                pid: '1001',
                type: 'alipay',
                out_trade_no: 'TEST_' + Date.now(),
                notify_url: 'https://example.com/notify',
                name: '测试商品',
                money: '10.00',
                sign: 'xxx'
            })
        });
        
        const createData = await createResponse.json();
        expect(createData.code).toBe(1);
        
        // 2. 模拟支付回调
        // ...
        
        // 3. 查询订单状态
        const queryResponse = await fetch(`http://localhost:8787/api.php?act=order&pid=1001&trade_no=${createData.trade_no}&sign=xxx`);
        const queryData = await queryResponse.json();
        
        expect(queryData.code).toBe(1);
        expect(queryData.status).toBe(1);
    });
});
```

---

## 最佳实践

1. **错误处理**: 所有异步操作都要有 try-catch
2. **日志记录**: 记录关键操作和错误
3. **幂等性**: 确保重复调用不会产生副作用
4. **超时处理**: 设置合理的请求超时时间
5. **重试机制**: 对于临时性错误实现重试
6. **安全存储**: 敏感配置使用 Secrets
7. **类型安全**: 使用 TypeScript 严格模式
