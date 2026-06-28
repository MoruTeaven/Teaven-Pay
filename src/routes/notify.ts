/**
 * 异步通知路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { getPlugin } from '../plugins';

export const notifyRouter = new Hono<{ Bindings: Env }>();

/**
 * 支付宝异步通知
 * POST /notify/alipay
 */
notifyRouter.post('/alipay', async (c) => {
    try {
        const body = await c.req.parseBody();
        
        // 查询支付宝通道配置
        const channel = await c.env.DB.prepare(
            "SELECT * FROM channels WHERE plugin = 'alipay' AND status = 1 LIMIT 1"
        ).first();
        
        if (!channel) {
            return c.text('fail');
        }
        
        const config = JSON.parse((channel as any).config || '{}');
        
        // 获取插件并验证通知
        const plugin = getPlugin('alipay');
        const result = await plugin.verifyNotify(body, {
            appId: config.appId,
            appSecret: config.appSecret,
            alipayPublicKey: config.alipayPublicKey
        });
        
        if (!result.success) {
            return c.text('fail');
        }
        
        // 处理支付成功
        if (result.status === 'success') {
            await handlePaymentSuccess(c.env, {
                tradeNo: result.tradeNo,
                outTradeNo: result.outTradeNo,
                thirdPartyTradeNo: result.thirdPartyTradeNo,
                buyer: result.buyer,
                paidAt: result.paidAt
            });
        }
        
        return c.text(result.response || 'success');
    } catch (error) {
        console.error('Alipay notify error:', error);
        return c.text('fail');
    }
});

/**
 * 微信支付异步通知
 * POST /notify/wxpay
 */
notifyRouter.post('/wxpay', async (c) => {
    try {
        const rawBody = await c.req.text();
        const body = JSON.parse(rawBody);
        
        // 查询微信支付通道配置
        const channel = await c.env.DB.prepare(
            "SELECT * FROM channels WHERE plugin = 'wxpay' AND status = 1 LIMIT 1"
        ).first();
        
        if (!channel) {
            return c.json({ code: 'FAIL', message: '通道不存在' });
        }
        
        const config = JSON.parse((channel as any).config || '{}');
        
        // 传递原始 headers 和 body 用于签名验证
        body._headers = {
            'wechatpay-signature': c.req.header('Wechatpay-Signature') || '',
            'wechatpay-timestamp': c.req.header('Wechatpay-Timestamp') || '',
            'wechatpay-nonce': c.req.header('Wechatpay-Nonce') || '',
            'wechatpay-serial': c.req.header('Wechatpay-Serial') || '',
        };
        body._rawBody = rawBody;
        
        // 获取插件并验证通知
        const plugin = getPlugin('wxpay');
        const result = await plugin.verifyNotify(body, {
            appId: config.appId,
            appSecret: config.appSecret,
            mchId: config.mchId,
            apiKey: config.apiKey
        });
        
        if (!result.success) {
            return c.json({ code: 'FAIL', message: '验证失败' });
        }
        
        // 处理支付成功
        if (result.status === 'success') {
            await handlePaymentSuccess(c.env, {
                tradeNo: result.tradeNo,
                outTradeNo: result.outTradeNo,
                thirdPartyTradeNo: result.thirdPartyTradeNo,
                buyer: result.buyer,
                paidAt: result.paidAt
            });
        }
        
        return c.json(JSON.parse(result.response || '{"code":"SUCCESS","message":"OK"}'));
    } catch (error) {
        console.error('Wxpay notify error:', error);
        return c.json({ code: 'FAIL', message: '系统错误' });
    }
});

/**
 * QQ钱包异步通知
 * POST /notify/qqpay
 */
notifyRouter.post('/qqpay', async (c) => {
    // TODO: 实现 QQ 钱包通知
    return c.text('success');
});

/**
 * 通用异步通知 (用于自定义插件)
 * POST /notify/:plugin
 */
notifyRouter.post('/:plugin', async (c) => {
    const { plugin: pluginId } = c.req.param();
    
    try {
        const body = await c.req.parseBody();
        
        // 查询通道配置
        const channel = await c.env.DB.prepare(
            'SELECT * FROM channels WHERE plugin = ? AND status = 1 LIMIT 1'
        ).bind(pluginId).first();
        
        if (!channel) {
            return c.text('fail');
        }
        
        const config = JSON.parse((channel as any).config || '{}');
        
        // 获取插件并验证通知
        const plugin = getPlugin(pluginId);
        const result = await plugin.verifyNotify(body, config);
        
        if (!result.success) {
            return c.text('fail');
        }
        
        // 处理支付成功
        if (result.status === 'success') {
            await handlePaymentSuccess(c.env, {
                tradeNo: result.tradeNo,
                outTradeNo: result.outTradeNo,
                thirdPartyTradeNo: result.thirdPartyTradeNo,
                buyer: result.buyer,
                paidAt: result.paidAt
            });
        }
        
        return c.text(result.response || 'success');
    } catch (error) {
        console.error(`${pluginId} notify error:`, error);
        return c.text('fail');
    }
});

/**
 * 处理支付成功
 */
async function handlePaymentSuccess(
    env: Env,
    data: {
        tradeNo: string;
        outTradeNo: string;
        thirdPartyTradeNo?: string;
        buyer?: string;
        paidAt?: string;
    }
) {
    const now = new Date().toISOString();
    
    // 查询订单
    const order = await env.DB.prepare(
        'SELECT * FROM orders WHERE id = ? AND status = 0'
    ).bind(data.tradeNo).first();
    
    if (!order) {
        console.log(`Order not found or already paid: ${data.tradeNo}`);
        return;
    }
    
    // 更新订单状态
    await env.DB.prepare(`
        UPDATE orders SET 
            status = 1,
            api_trade_no = ?,
            buyer = ?,
            paid_at = ?,
            notify_status = 0
        WHERE id = ?
    `).bind(
        data.thirdPartyTradeNo || '',
        data.buyer || '',
        data.paidAt || now,
        data.tradeNo
    ).run();
    
    // 更新商户余额
    const amount = (order as any).amount;
    const fee = (order as any).fee || 0;
    const profit = amount - fee;
    
    await env.DB.prepare(`
        UPDATE users SET 
            balance = balance + ?,
            today_income = today_income + ?,
            total_income = total_income + ?,
            today_orders = today_orders + 1,
            total_orders = total_orders + 1
        WHERE id = ?
    `).bind(profit, profit, profit, (order as any).user_id).run();
    
    // 发送异步通知给商户
    await sendMerchantNotification(env, order as any);
    
    console.log(`Payment success: ${data.tradeNo}`);
}

/**
 * 发送商户通知
 */
async function sendMerchantNotification(env: Env, order: any) {
    if (!order.notify_url) {
        return;
    }
    
    // 验证通知 URL 合法性 (防止 SSRF)
    if (!isValidNotifyUrl(order.notify_url)) {
        console.error(`Invalid notify_url blocked: ${order.notify_url}`);
        return;
    }
    
    try {
        // 查询商户信息
        const user = await env.DB.prepare(
            'SELECT * FROM users WHERE id = ?'
        ).bind(order.user_id).first();
        
        if (!user) {
            return;
        }
        
        // 构建通知参数
        const notifyParams: Record<string, any> = {
            pid: order.user_id,
            trade_no: order.id,
            out_trade_no: order.out_trade_no,
            type: order.payment_type,
            name: order.name,
            money: order.amount.toFixed(2),
            param: order.param || '',
            trade_status: 'TRADE_SUCCESS'
        };
        
        // 生成签名
        const { generateSignAsync } = await import('../utils/crypto');
        const signType = (user as any).api_key_type || 'hmac-sha256';
        notifyParams.sign = await generateSignAsync(notifyParams, (user as any).api_key, signType);
        notifyParams.sign_type = signType === 'md5' ? 'MD5' : 'HMAC-SHA256';
        
        // 发送通知
        const response = await fetch(order.notify_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(notifyParams)
        });
        
        const responseText = await response.text();
        
        // 更新通知状态
        if (responseText.toLowerCase() === 'success') {
            await env.DB.prepare(`
                UPDATE orders SET 
                    notify_status = 1,
                    notify_count = notify_count + 1,
                    last_notify_at = datetime('now')
                WHERE id = ?
            `).bind(order.id).run();
        } else {
            await env.DB.prepare(`
                UPDATE orders SET 
                    notify_status = 2,
                    notify_count = notify_count + 1,
                    last_notify_at = datetime('now')
                WHERE id = ?
            `).bind(order.id).run();
            
            // TODO: 加入重试队列
        }
    } catch (error) {
        console.error('Send merchant notification error:', error);
        
        // 更新通知失败状态
        await env.DB.prepare(`
            UPDATE orders SET 
                notify_status = 2,
                notify_count = notify_count + 1,
                last_notify_at = datetime('now')
            WHERE id = ?
        `).bind(order.id).run();
    }
}

/**
 * 验证通知 URL 合法性 (防止 SSRF)
 * 只允许 https 协议，禁止内网地址
 */
function isValidNotifyUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        const hostname = parsed.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
        if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.)/.test(hostname)) return false;
        if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
        return true;
    } catch {
        return false;
    }
}
