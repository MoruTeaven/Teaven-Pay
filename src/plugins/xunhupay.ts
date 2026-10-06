/**
 * 虎皮椒支付插件
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
import { generateNonce } from '../utils/crypto';
import md5 from 'md5';

export class XunhupayPlugin implements PaymentPlugin {
    id = 'xunhupay';
    name = '虎皮椒';
    version = '1.0.0';
    supportedTypes = ['alipay', 'wxpay'];
    
    private apiBase = 'https://api.xunhupay.com';
    
    /**
     * 生成虎皮椒签名 (MD5)
     */
    private generateHash(params: Record<string, any>, appSecret: string): string {
        // 1. 按参数名ASCII码排序
        const sortedKeys = Object.keys(params).sort();
        const parts: string[] = [];
        
        for (const key of sortedKeys) {
            const value = params[key];
            // 跳过hash字段和空值
            if (key === 'hash' || value === undefined || value === null || value === '') {
                continue;
            }
            parts.push(`${key}=${value}`);
        }
        
        // 2. 拼接字符串
        const stringA = parts.join('&');
        
        // 3. 最后拼接appSecret
        const stringSignTemp = stringA + appSecret;
        
        // 4. MD5运算
        return md5(stringSignTemp);
    }
    
    
    /**
     * 创建支付订单
     */
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        try {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonceStr = generateNonce(32);
            
            // 构建请求参数
            const params: Record<string, any> = {
                version: '1.1',
                appid: config.appId,
                trade_order_id: order.tradeNo,
                total_fee: order.amount.toFixed(2),
                title: order.subject.substring(0, 127),
                time: timestamp,
                notify_url: config.notifyUrl || '',
                nonce_str: nonceStr
            };
            
            // 可选参数
            if (order.body) {
                params.attach = order.body;
            }
            
            // 生成签名
            params.hash = this.generateHash(params, config.appSecret);
            
            // 发送请求
            const response = await fetch(`${this.apiBase}/payment/do.html`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(params)
            });
            
            const data: any = await response.json();
            
            if (data.errcode === 0) {
                return {
                    success: true,
                    method: 'jump',
                    payUrl: data.url,
                    qrcode: data.url_qrcode,
                    qrcodeUrl: data.url_qrcode
                };
            } else {
                return {
                    success: false,
                    method: 'jump',
                    message: data.errmsg || '创建支付失败'
                };
            }
        } catch (error: any) {
            return {
                success: false,
                method: 'jump',
                message: error.message || '创建支付失败'
            };
        }
    }
    
    /**
     * 验证支付回调
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        try {
            // 验证签名
            const hash = payload.hash;
            const params: Record<string, any> = {};
            
            for (const [key, value] of Object.entries(payload)) {
                if (key !== 'hash') {
                    params[key] = value;
                }
            }
            
            const expectedHash = this.generateHash(params, config.appSecret);
            
            if (hash !== expectedHash) {
                return {
                    success: false,
                    tradeNo: '',
                    outTradeNo: '',
                    status: 'failed'
                };
            }
            
            // 检查支付状态
            const status = payload.status;
            let paymentStatus: NotifyResult['status'] = 'pending';
            
            if (status === 'OD') {
                paymentStatus = 'success';
            } else if (status === 'CD') {
                paymentStatus = 'failed';
            }
            
            return {
                success: true,
                tradeNo: payload.trade_order_id || '',
                outTradeNo: payload.trade_order_id || '',
                thirdPartyTradeNo: payload.transaction_id || payload.open_order_id,
                status: paymentStatus,
                paidAt: payload.time ? new Date(parseInt(payload.time) * 1000).toISOString() : undefined,
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
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonceStr = generateNonce(32);
            
            const params: Record<string, any> = {
                appid: config.appId,
                out_trade_order: tradeNo,
                time: timestamp,
                nonce_str: nonceStr
            };
            
            params.hash = this.generateHash(params, config.appSecret);
            
            const response = await fetch(`${this.apiBase}/payment/query.html`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(params)
            });
            
            const data: any = await response.json();
            
            if (data.errcode === 0 && data.data) {
                const status = data.data.status;
                let orderStatus: OrderStatus['status'] = 'pending';
                
                if (status === 'OD') {
                    orderStatus = 'paid';
                } else if (status === 'CD') {
                    orderStatus = 'closed';
                } else if (status === 'RD' || status === 'UD') {
                    orderStatus = 'refunded';
                }
                
                return {
                    status: orderStatus,
                    thirdPartyTradeNo: data.data.open_order_id,
                    paidAt: data.data.payment_time ? new Date(parseInt(data.data.payment_time) * 1000).toISOString() : undefined
                };
            }
            
            return {
                status: 'pending'
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
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonceStr = generateNonce(32);
            
            const params: Record<string, any> = {
                appid: config.appId,
                trade_order_id: order.tradeNo,
                time: timestamp,
                nonce_str: nonceStr
            };
            
            params.hash = this.generateHash(params, config.appSecret);
            
            const response = await fetch(`${this.apiBase}/payment/refund.html`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(params)
            });
            
            const data: any = await response.json();
            
            if (data.errcode === 0) {
                return {
                    success: true,
                    refundNo: data.out_refund_no || `REF_${Date.now()}`,
                    thirdPartyRefundNo: data.transaction_id
                };
            } else {
                return {
                    success: false,
                    message: data.errmsg || '退款失败'
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
        // 虎皮椒没有单独的退款查询接口，通过订单查询获取退款状态
        try {
            return {
                status: 'processing'
            };
        } catch (error) {
            return {
                status: 'processing'
            };
        }
    }
}