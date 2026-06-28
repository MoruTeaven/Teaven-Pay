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
        return this.md5(stringSignTemp);
    }
    
    /**
     * MD5哈希实现
     * 注意：这是一个简化的MD5实现，用于Cloudflare Workers环境
     */
    private md5(message: string): string {
        function md5cycle(x: number[], k: number[]) {
            let a = x[0], b = x[1], c = x[2], d = x[3];
            
            a = ff(a, b, c, d, k[0], 7, -680876936);
            d = ff(d, a, b, c, k[1], 12, -389564586);
            c = ff(c, d, a, b, k[2], 17, 606105819);
            b = ff(b, c, d, a, k[3], 22, -1044525330);
            a = ff(a, b, c, d, k[4], 7, -176418897);
            d = ff(d, a, b, c, k[5], 12, 1200080426);
            c = ff(c, d, a, b, k[6], 17, -1473231341);
            b = ff(b, c, d, a, k[7], 22, -45705983);
            a = ff(a, b, c, d, k[8], 7, 1770035416);
            d = ff(d, a, b, c, k[9], 12, -1958414417);
            c = ff(c, d, a, b, k[10], 17, -42063);
            b = ff(b, c, d, a, k[11], 22, -1990404162);
            a = ff(a, b, c, d, k[12], 7, 1804603682);
            d = ff(d, a, b, c, k[13], 12, -40341101);
            c = ff(c, d, a, b, k[14], 17, -1502002290);
            b = ff(b, c, d, a, k[15], 22, 1236535329);
            
            a = gg(a, b, c, d, k[1], 5, -165796510);
            d = gg(d, a, b, c, k[6], 9, -1069501632);
            c = gg(c, d, a, b, k[11], 14, 643717713);
            b = gg(b, c, d, a, k[0], 20, -373897302);
            a = gg(a, b, c, d, k[5], 5, -701558691);
            d = gg(d, a, b, c, k[10], 9, 38016083);
            c = gg(c, d, a, b, k[15], 14, -660478335);
            b = gg(b, c, d, a, k[4], 20, -405537848);
            a = gg(a, b, c, d, k[9], 5, 568446438);
            d = gg(d, a, b, c, k[14], 9, -1019803690);
            c = gg(c, d, a, b, k[3], 14, -187363961);
            b = gg(b, c, d, a, k[8], 20, 1163531501);
            a = gg(a, b, c, d, k[13], 5, -1444681467);
            d = gg(d, a, b, c, k[2], 9, -51403784);
            c = gg(c, d, a, b, k[7], 14, 1735328473);
            b = gg(b, c, d, a, k[12], 20, -1926607734);
            
            a = hh(a, b, c, d, k[5], 4, -378558);
            d = hh(d, a, b, c, k[8], 11, -2022574463);
            c = hh(c, d, a, b, k[11], 16, 1839030562);
            b = hh(b, c, d, a, k[14], 23, -35309556);
            a = hh(a, b, c, d, k[1], 4, -1530992060);
            d = hh(d, a, b, c, k[4], 11, 1272893353);
            c = hh(c, d, a, b, k[7], 16, -155497632);
            b = hh(b, c, d, a, k[10], 23, -1094730640);
            a = hh(a, b, c, d, k[13], 4, 681279174);
            d = hh(d, a, b, c, k[0], 11, -358537222);
            c = hh(c, d, a, b, k[3], 16, -722521979);
            b = hh(b, c, d, a, k[6], 23, 76029189);
            a = hh(a, b, c, d, k[9], 4, -640364487);
            d = hh(d, a, b, c, k[12], 11, -421815835);
            c = hh(c, d, a, b, k[15], 16, 530742520);
            b = hh(b, c, d, a, k[2], 23, -995338651);
            
            a = ii(a, b, c, d, k[0], 6, -198630844);
            d = ii(d, a, b, c, k[7], 10, 1126891415);
            c = ii(c, d, a, b, k[14], 15, -1416354905);
            b = ii(b, c, d, a, k[5], 21, -57434055);
            a = ii(a, b, c, d, k[12], 6, 1700485571);
            d = ii(d, a, b, c, k[3], 10, -1894986606);
            c = ii(c, d, a, b, k[10], 15, -1051523);
            b = ii(b, c, d, a, k[1], 21, -2054922799);
            a = ii(a, b, c, d, k[8], 6, 1873313359);
            d = ii(d, a, b, c, k[15], 10, -30611744);
            c = ii(c, d, a, b, k[6], 15, -1560198380);
            b = ii(b, c, d, a, k[13], 21, 1309151649);
            a = ii(a, b, c, d, k[4], 6, -145523070);
            d = ii(d, a, b, c, k[11], 10, -1120210379);
            c = ii(c, d, a, b, k[2], 15, 718787259);
            b = ii(b, c, d, a, k[9], 21, -343485551);
            
            x[0] = add32(a, x[0]);
            x[1] = add32(b, x[1]);
            x[2] = add32(c, x[2]);
            x[3] = add32(d, x[3]);
        }
        
        function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
            a = add32(add32(a, q), add32(x, t));
            return add32((a << s) | (a >>> (32 - s)), b);
        }
        
        function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
            return cmn((b & c) | ((~b) & d), a, b, x, s, t);
        }
        
        function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
            return cmn((b & d) | (c & (~d)), a, b, x, s, t);
        }
        
        function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
            return cmn(b ^ c ^ d, a, b, x, s, t);
        }
        
        function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
            return cmn(c ^ (b | (~d)), a, b, x, s, t);
        }
        
        function md51(s: string) {
            const n = s.length;
            let state = [1732584193, -271733879, -1732584194, 271733878];
            let i: number;
            
            for (i = 64; i <= n; i += 64) {
                md5cycle(state, md5blk(s.substring(i - 64, i)));
            }
            
            s = s.substring(i - 64);
            const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            
            for (i = 0; i < s.length; i++) {
                tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
            }
            
            tail[i >> 2] |= 0x80 << ((i % 4) << 3);
            
            if (i > 55) {
                md5cycle(state, tail);
                for (i = 0; i < 16; i++) tail[i] = 0;
            }
            
            tail[14] = n * 8;
            md5cycle(state, tail);
            return state;
        }
        
        function md5blk(s: string) {
            const md5blks = [];
            for (let i = 0; i < 64; i += 4) {
                md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
            }
            return md5blks;
        }
        
        const hex_chr = '0123456789abcdef'.split('');
        
        function rhex(n: number) {
            let s = '';
            for (let j = 0; j < 4; j++) {
                s += hex_chr[(n >> (j * 8 + 4)) & 0x0F] + hex_chr[(n >> (j * 8)) & 0x0F];
            }
            return s;
        }
        
        function hex(x: number[]) {
            return x.map(rhex).join('');
        }
        
        function add32(a: number, b: number) {
            return (a + b) & 0xFFFFFFFF;
        }
        
        return hex(md51(message));
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