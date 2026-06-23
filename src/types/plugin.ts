/**
 * 支付插件类型定义
 */

/**
 * 订单信息
 */
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

/**
 * 插件配置
 */
export interface PluginConfig {
    /** 应用 ID / 商户号 */
    appId: string;
    
    /** 应用密钥 / 商户密钥 */
    appSecret: string;
    
    /** 通知地址 */
    notifyUrl?: string;
    
    /** 其他配置 */
    [key: string]: any;
}

/**
 * 支付结果
 */
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

/**
 * JSAPI 参数
 */
export interface JsapiParams {
    appId: string;
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: string;
    paySign: string;
}

/**
 * 通知结果
 */
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

/**
 * 订单状态
 */
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

/**
 * 退款结果
 */
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

/**
 * 退款状态
 */
export interface RefundStatus {
    /** 退款状态 */
    status: 'processing' | 'success' | 'failed';
    
    /** 退款金额 */
    amount?: number;
    
    /** 退款时间 */
    refundedAt?: string;
}

/**
 * 支付插件接口
 */
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
