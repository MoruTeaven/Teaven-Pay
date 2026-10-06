/**
 * 异步通知路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { getPlugin } from '../plugins';
import { getRequestLogMeta, headersToLogObject, logOrderEvent, logPaymentEvent, logWebhookEvent } from '../utils/logging';
import { isSafeOutboundUrl } from '../utils/netSecurity';

export const notifyRouter = new Hono<{ Bindings: Env }>();

/**
 * 支付宝异步通知
 * POST /notify/alipay
 */
notifyRouter.post('/alipay', async (c) => {
    try {
        const body = await c.req.parseBody();
        const requestMeta = getRequestLogMeta(c.req.raw);
        
        // 查询支付宝通道配置
        const channel = await c.env.DB.prepare(
            "SELECT * FROM channels WHERE plugin = 'alipay' AND status = 1 LIMIT 1"
        ).first();
        
        if (!channel) {
            await logWebhookEvent(c.env, {
                plugin: 'alipay',
                webhookType: 'channel_notify',
                direction: 'inbound',
                url: c.req.url,
                method: c.req.method,
                success: false,
                requestHeaders: headersToLogObject(c.req.raw.headers),
                requestBody: body,
                responseBody: 'fail',
                errorMessage: '通道不存在',
                ...requestMeta,
            });
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
            await logWebhookEvent(c.env, {
                orderId: result.tradeNo || null,
                plugin: 'alipay',
                webhookType: 'channel_notify',
                direction: 'inbound',
                url: c.req.url,
                method: c.req.method,
                success: false,
                requestHeaders: headersToLogObject(c.req.raw.headers),
                requestBody: body,
                responseBody: 'fail',
                errorMessage: '回调验签失败',
                ...requestMeta,
            });
            return c.text('fail');
        }

        await logWebhookEvent(c.env, {
            orderId: result.tradeNo || null,
            plugin: 'alipay',
            webhookType: 'channel_notify',
            direction: 'inbound',
            url: c.req.url,
            method: c.req.method,
            success: true,
            requestHeaders: headersToLogObject(c.req.raw.headers),
            requestBody: body,
            responseBody: result.response || 'success',
            ...requestMeta,
        });
        
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
        const requestMeta = getRequestLogMeta(c.req.raw);
        
        // 查询微信支付通道配置
        const channel = await c.env.DB.prepare(
            "SELECT * FROM channels WHERE plugin = 'wxpay' AND status = 1 LIMIT 1"
        ).first();
        
        if (!channel) {
            await logWebhookEvent(c.env, {
                plugin: 'wxpay',
                webhookType: 'channel_notify',
                direction: 'inbound',
                url: c.req.url,
                method: c.req.method,
                success: false,
                requestHeaders: headersToLogObject(c.req.raw.headers),
                requestBody: body,
                responseBody: { code: 'FAIL', message: '通道不存在' },
                errorMessage: '通道不存在',
                ...requestMeta,
            });
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
            apiKey: config.apiKey,
            db: c.env.DB
        });
        
        if (!result.success) {
            await logWebhookEvent(c.env, {
                orderId: result.tradeNo || null,
                plugin: 'wxpay',
                webhookType: 'channel_notify',
                direction: 'inbound',
                url: c.req.url,
                method: c.req.method,
                success: false,
                requestHeaders: headersToLogObject(c.req.raw.headers),
                requestBody: body,
                responseBody: {
                    code: 'FAIL',
                    message: '验证失败',
                    error_code: result.errorCode || 'VERIFY_FAILED'
                },
                errorMessage: `回调验签失败: ${result.errorCode || 'VERIFY_FAILED'} ${result.message || ''}`.trim(),
                ...requestMeta,
            });
            return c.json({
                code: 'FAIL',
                message: '验证失败',
                error_code: result.errorCode || 'VERIFY_FAILED'
            });
        }

        await logWebhookEvent(c.env, {
            orderId: result.tradeNo || null,
            plugin: 'wxpay',
            webhookType: 'channel_notify',
            direction: 'inbound',
            url: c.req.url,
            method: c.req.method,
            success: true,
            requestHeaders: headersToLogObject(c.req.raw.headers),
            requestBody: body,
            responseBody: result.response || { code: 'SUCCESS', message: 'OK' },
            ...requestMeta,
        });
        
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
    const body = await c.req.parseBody();
    await logWebhookEvent(c.env, {
        plugin: 'qqpay',
        webhookType: 'channel_notify',
        direction: 'inbound',
        url: c.req.url,
        method: c.req.method,
        success: true,
        requestHeaders: headersToLogObject(c.req.raw.headers),
        requestBody: body,
        responseBody: 'success',
        ...getRequestLogMeta(c.req.raw),
    });
    return c.text('success');
});

/**
 * 通用异步通知 (用于自定义插件)
 * POST/GET /notify/:plugin
 */
const pluginNotifyHandler = async (c: any) => {
    const { plugin: pluginId } = c.req.param();

    try {
        // 同时支持 POST 和 GET，虎皮椒用 POST form 表单
        let body: Record<string, any>;
        if (c.req.method === 'GET') {
            body = c.req.query();
        } else {
            body = await c.req.parseBody();
        }
        const requestMeta = getRequestLogMeta(c.req.raw);


        // 查询通道配置
        const channel = await c.env.DB.prepare(
            'SELECT * FROM channels WHERE plugin = ? AND status = 1 LIMIT 1'
        ).bind(pluginId).first();

        if (!channel) {
            console.error(`[Notify/${pluginId}] channel not found`);
            await logWebhookEvent(c.env, {
                plugin: pluginId,
                webhookType: 'channel_notify',
                direction: 'inbound',
                url: c.req.url,
                method: c.req.method,
                success: false,
                requestHeaders: headersToLogObject(c.req.raw.headers),
                requestBody: body,
                responseBody: 'fail',
                errorMessage: '通道不存在',
                ...requestMeta,
            });
            return c.text('fail');
        }

        const config = JSON.parse((channel as any).config || '{}');

        // 获取插件并验证通知
        const plugin = getPlugin(pluginId);
        const result = await plugin.verifyNotify(body, config);

        if (!result.success) {
            console.error(`[Notify/${pluginId}] verifyNotify failed`);
            await logWebhookEvent(c.env, {
                orderId: result.tradeNo || null,
                plugin: pluginId,
                webhookType: 'channel_notify',
                direction: 'inbound',
                url: c.req.url,
                method: c.req.method,
                success: false,
                requestHeaders: headersToLogObject(c.req.raw.headers),
                requestBody: body,
                responseBody: 'fail',
                errorMessage: '回调验签失败',
                ...requestMeta,
            });
            return c.text('fail');
        }

        await logWebhookEvent(c.env, {
            orderId: result.tradeNo || null,
            plugin: pluginId,
            webhookType: 'channel_notify',
            direction: 'inbound',
            url: c.req.url,
            method: c.req.method,
            success: true,
            requestHeaders: headersToLogObject(c.req.raw.headers),
            requestBody: body,
            responseBody: result.response || 'success',
            ...requestMeta,
        });

        // 处理支付成功
        if (result.status === 'success') {
            console.log(`[Notify/${pluginId}] payment success, tradeNo: ${result.tradeNo}`);
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
        console.error(`[Notify/${pluginId}] error:`, error);
        return c.text('fail');
    }
};

notifyRouter.post('/:plugin', pluginNotifyHandler);
notifyRouter.get('/:plugin', pluginNotifyHandler);

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

    await logOrderEvent(env, {
        orderId: data.tradeNo,
        userId: (order as any).user_id,
        outTradeNo: (order as any).out_trade_no,
        action: 'paid',
        fromStatus: 0,
        toStatus: 1,
        amount,
        detail: { source: 'channel_notify', third_party_trade_no: data.thirdPartyTradeNo || '' },
    });

    await logPaymentEvent(env, {
        orderId: data.tradeNo,
        userId: (order as any).user_id,
        channelId: (order as any).channel_id,
        plugin: (order as any).plugin,
        direction: 'internal',
        action: 'notify_payment_success',
        status: 'success',
        amount,
        thirdPartyTradeNo: data.thirdPartyTradeNo || null,
        responseData: { buyer: data.buyer || '', paid_at: data.paidAt || now },
    });
    
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
    // 同步层：协议 / 主机黑名单 / IP 字面量
    // 异步层：DNS 解析后二次校验，防 nip.io 等别名指向内网
    const urlGuard = await isSafeOutboundUrl(order.notify_url);
    if (!urlGuard.ok) {
        console.error('[Notify] blocked unsafe notify_url:', urlGuard.reason || 'unknown');
        await logWebhookEvent(env, {
            orderId: order.id,
            userId: order.user_id,
            plugin: order.plugin,
            webhookType: 'merchant_notify',
            direction: 'outbound',
            url: order.notify_url,
            method: 'POST',
            success: false,
            errorMessage: '通知URL不合法: ' + (urlGuard.reason || 'unknown'),
        });
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
        const notifySuccess = responseText.toLowerCase() === 'success';

        await logWebhookEvent(env, {
            orderId: order.id,
            userId: order.user_id,
            plugin: order.plugin,
            webhookType: 'merchant_notify',
            direction: 'outbound',
            url: order.notify_url,
            method: 'POST',
            httpStatus: response.status,
            success: notifySuccess,
            requestBody: notifyParams,
            responseBody: responseText,
            errorMessage: notifySuccess ? null : '商户未返回 success',
        });
        
        // 更新通知状态
        if (notifySuccess) {
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
        await logWebhookEvent(env, {
            orderId: order.id,
            userId: order.user_id,
            plugin: order.plugin,
            webhookType: 'merchant_notify',
            direction: 'outbound',
            url: order.notify_url,
            method: 'POST',
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        
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
 *
 * 完整校验逻辑已下沉到 src/utils/netSecurity.ts：
 *   - 仅允许 https
 *   - 拒绝 localhost / .local / .internal / 元数据域名 / DNS 别名服务
 *   - 覆盖 127.0.0.0/8 全段、169.254.0.0/16、10/8、172.16/12、192.168/16、
 *     100.64/10、100.64 CGNAT、组播与保留段、IPv6 回环/ULA/链路本地
 *   - DNS 解析后二次校验，防 nip.io 等域名指向内网 IP 的绕过
 */
export async function isValidNotifyUrl(url: string): Promise<boolean> {
    const result = await isSafeOutboundUrl(url);
    return result.ok;
}