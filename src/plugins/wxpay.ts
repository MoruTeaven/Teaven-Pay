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
import { rsaSign, generateNonce } from '../utils/crypto';

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
     * 验证支付回调
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        try {
            // TODO: 实现微信支付回调验证
            // 需要验证签名和解密资源数据
            
            return {
                success: true,
                tradeNo: payload.out_trade_no || '',
                outTradeNo: payload.out_trade_no || '',
                thirdPartyTradeNo: payload.transaction_id,
                status: 'success',
                buyer: payload.payer?.openid,
                paidAt: payload.success_time,
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
