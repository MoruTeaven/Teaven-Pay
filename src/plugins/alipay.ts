/**
 * 支付宝支付插件
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
import { rsaSign, rsaVerify } from '../utils/crypto';

export class AlipayPlugin implements PaymentPlugin {
    id = 'alipay';
    name = '支付宝';
    version = '1.0.0';
    supportedTypes = ['alipay'];
    
    private apiBase = 'https://openapi.alipay.com/gateway.do';
    
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
            
            const params: Record<string, string> = {
                app_id: config.appId,
                method: 'alipay.trade.app.pay',
                charset: 'utf-8',
                sign_type: 'RSA2',
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                version: '1.0',
                biz_content: JSON.stringify(bizContent)
            };
            
            // 生成签名
            params['sign'] = await rsaSign(params, config.appSecret);
            
            // 构建支付参数
            const payParams = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                payParams.append(key, value);
            }
            
            return {
                success: true,
                method: 'jump',
                payUrl: `${this.apiBase}?${payParams.toString()}`
            };
        } catch (error: any) {
            return {
                success: false,
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
            const sign = payload.sign;
            const signType = payload.sign_type;
            
            // 构建待验签字符串
            const params: Record<string, string> = {};
            for (const [key, value] of Object.entries(payload)) {
                if (key !== 'sign' && key !== 'sign_type') {
                    params[key] = value as string;
                }
            }
            
            // 验证签名
            const isValid = await rsaVerify(params, sign, config.alipayPublicKey || '');
            
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
            const params: Record<string, string> = {
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
            
            params['sign'] = await rsaSign(params, config.appSecret);
            
            const response = await fetch(this.apiBase, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            
            const data: any = await response.json();
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
            
            const params: Record<string, string> = {
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
            
            params['sign'] = await rsaSign(params, config.appSecret);
            
            const response = await fetch(this.apiBase, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            
            const data: any = await response.json();
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
            const params: Record<string, string> = {
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
            
            params['sign'] = await rsaSign(params, config.appSecret);
            
            const response = await fetch(this.apiBase, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            
            const data: any = await response.json();
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
