/**
 * QQ钱包支付插件
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

export class QQPayPlugin implements PaymentPlugin {
    id = 'qqpay';
    name = 'QQ钱包';
    version = '1.0.0';
    supportedTypes = ['qqpay'];
    
    /**
     * 创建支付订单
     */
    async createPayment(order: OrderInfo, config: PluginConfig): Promise<PaymentResult> {
        // TODO: 实现 QQ 钱包支付
        return {
            success: false,
            message: 'QQ钱包支付暂未实现'
        };
    }
    
    /**
     * 验证支付回调
     */
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        // TODO: 实现 QQ 钱包回调验证
        return {
            success: false,
            tradeNo: '',
            outTradeNo: '',
            status: 'failed'
        };
    }
    
    /**
     * 查询订单状态
     */
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderStatus> {
        // TODO: 实现 QQ 钱包订单查询
        return {
            status: 'pending'
        };
    }
    
    /**
     * 申请退款
     */
    async refund(order: OrderInfo, amount: number, config: PluginConfig): Promise<RefundResult> {
        // TODO: 实现 QQ 钱包退款
        return {
            success: false,
            message: 'QQ钱包退款暂未实现'
        };
    }
    
    /**
     * 查询退款状态
     */
    async queryRefund(refundNo: string, config: PluginConfig): Promise<RefundStatus> {
        // TODO: 实现 QQ 钱包退款查询
        return {
            status: 'processing'
        };
    }
}
