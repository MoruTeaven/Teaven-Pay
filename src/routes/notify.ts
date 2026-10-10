/**
 * 异步通知路由
 */

import { Hono } from 'hono';
import { Env, OrderRow } from '../types/env';
import { getPlugin } from '../plugins';
import { decryptChannelConfig } from '../utils/crypto';
import { signOutboundPayload } from '../utils/apiKeyAuth';
import { getRequestLogMeta, headersToLogObject, logOrderEvent, logPaymentEvent, logWebhookEvent } from '../utils/logging';
import { CREDIT_OUTCOME, CREDIT_SOURCE, CreditOutcome, creditOrder } from '../utils/credit';
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
        
        const config = await decryptChannelConfig((channel as any).config, c.env.ENCRYPTION_KEY);
        
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
                paidAt: result.paidAt,
                paidAmount: result.paidAmount
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
        
        const config = await decryptChannelConfig((channel as any).config, c.env.ENCRYPTION_KEY);
        
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
                paidAt: result.paidAt,
                paidAmount: result.paidAmount
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

        const config = await decryptChannelConfig((channel as any).config, c.env.ENCRYPTION_KEY);

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
                paidAt: result.paidAt,
                paidAmount: result.paidAmount
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
 *
 * 幂等与金额核对全部交给 creditOrder()：
 *  - 本函数的 SELECT 只是取入账前快照，不再充当幂等判据（原实现依赖它，
 *    与后面的无守卫 UPDATE 之间存在竞态窗口，并发回调/回调+轮询交错会双倍入账）；
 *  - creditOrder() 先用「回调实付金额 == 订单金额」（容差 0）核对，不一致只记日志不入账；
 *  - 再用 UPDATE orders ... WHERE id = ? AND status = 0 做状态翻转 CAS，
 *    只有 meta.changes > 0 的那一次才会执行余额入账（余额+统计+流水在同一 D1 事务内）。
 */
async function handlePaymentSuccess(
    env: Env,
    data: {
        tradeNo: string;
        outTradeNo: string;
        thirdPartyTradeNo?: string;
        buyer?: string;
        paidAt?: string;
        paidAmount?: number | null;
    }
): Promise<CreditOutcome> {
    // 入账前快照：不再限制 status = 0，便于区分「不存在 / 已入账 / 已关闭」并留痕
    const order = await env.DB.prepare(
        'SELECT * FROM orders WHERE id = ?'
    ).bind(data.tradeNo).first<OrderRow>();

    if (!order) {
        console.log(`Order not found: ${data.tradeNo}`);
        return CREDIT_OUTCOME.NOT_FOUND;
    }

    if (order.status !== 0) {
        // 0 之外的状态说明已被轮询路径/人工/上一次回调处理过，直接确认为重复通知
        console.log(`Order already settled, skip credit: ${data.tradeNo} (status=${order.status})`);
        return CREDIT_OUTCOME.DUPLICATE;
    }

    const result = await creditOrder(
        env,
        order,
        {
            tradeNo: data.tradeNo,
            thirdPartyTradeNo: data.thirdPartyTradeNo,
            buyer: data.buyer,
            paidAt: data.paidAt,
            paidAmount: data.paidAmount,
        },
        CREDIT_SOURCE.CHANNEL_NOTIFY
    );

    if (result.outcome === CREDIT_OUTCOME.CREDITED) {
        // 只有本次真正抢到入账时才通知商户，重复回调不会重复推送
        await sendMerchantNotification(env, order as any);
        console.log(`Payment success: ${data.tradeNo}`);
    }

    return result.outcome;
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
        
        // 生成签名：密钥来源与入站验签统一为 api_keys 表（status = 1 的主密钥），
        // 因此商户在面板重置密钥后，入站验签与出站通知签名始终使用同一把 key。
        // 原实现读取 users.api_key 旧字段，重置后与 api_keys 表不一致，导致商户验签失败。
        const signed = await signOutboundPayload(env.DB, order.user_id, notifyParams);
        if (!signed) {
            console.error('[Notify] no active api key, skip merchant notification:', order.user_id);
            await logWebhookEvent(env, {
                orderId: order.id,
                userId: order.user_id,
                plugin: order.plugin,
                webhookType: 'merchant_notify',
                direction: 'outbound',
                url: order.notify_url,
                method: 'POST',
                success: false,
                errorMessage: '商户未配置可用的 API 密钥，未发送通知',
            });
            return;
        }
        notifyParams.sign = signed.sign;
        notifyParams.sign_type = signed.signingKey.signTypeLabel;
        
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