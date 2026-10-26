/**
 * 支付路由
 */

import { Hono } from 'hono';
import { Env, OrderRow } from '../types/env';
import { generateUUIDv7 } from '../utils/uuid';
import { decryptChannelConfig } from '../utils/crypto';
import { isTimestampFresh, verifyCashierSign, verifyCashierTicket } from '../utils/cashierAuth';
import { authorizeKeyOrSign, authorizeSignedRequest, getPrimaryApiKey, listActiveApiKeys, matchApiKey, readApiKeyFromHeaders } from '../utils/apiKeyAuth';
import { isSafeOutboundUrl } from '../utils/netSecurity';
import { verifyOrderStatusToken } from '../utils/orderStatusAuth';
import { getPlugin } from '../plugins';
import type { PluginConfig, RefundResult } from '../types/plugin';
import { getSiteUrl } from '../utils/site';
import { getRequestLogMeta, logOrderEvent, logPaymentEvent } from '../utils/logging';
import { CREDIT_OUTCOME, CREDIT_SOURCE, creditOrder } from '../utils/credit';

export const payRouter = new Hono<{ Bindings: Env }>();

/** 订单状态接口的认证结果 */
interface OrderStatusAuthResult {
    ok: boolean;
    code?: number;
    msg?: string;
    status?: 200 | 401 | 403;
}

/**
 * 订单状态查询的访问控制（B-3）
 *
 * 两条合法路径：
 *   1. 订单票据：由收银台页面服务端签发，只绑定这一个 tradeNo，供浏览器轮询；
 *   2. 商户签名：pid + trade_no + timestamp + sign，用于服务端直连。
 *
 * 两条都不满足时返回 401，不再返回订单状态与金额。
 */
async function authorizeOrderStatusRequest(
    c: any,
    env: Env,
    order: any
): Promise<OrderStatusAuthResult> {
    const tradeNo: string = order.id;
    const token = c.req.query('token') || c.req.header('X-Order-Token') || '';
    const pid = c.req.query('pid') || '';
    const sign = c.req.query('sign') || '';
    const timestamp = c.req.query('timestamp') || '';

    // 路径 A：订单票据
    if (token) {
        const keys = (await listActiveApiKeys(env.DB, order.user_id)).map((row) => row.api_key);
        const valid = await verifyOrderStatusToken(token, tradeNo, keys);
        if (!valid) {
            return { ok: false, code: -2, msg: '订单访问凭证无效或已过期', status: 401 };
        }
        return { ok: true };
    }

    // 路径 B：商户签名（必须带 pid/sign/timestamp）
    if (!pid && !sign) {
        return { ok: false, code: -1, msg: '缺少订单访问凭证：请使用 token 签名或商户签名', status: 401 };
    }

    const auth = await authorizeSignedRequest(env.DB, {
        pid,
        sign,
        timestamp,
        params: { trade_no: tradeNo },
    });
    if (!auth.ok) {
        return { ok: false, code: auth.code, msg: auth.msg, status: 401 };
    }

    // 签名有效，但订单必须属于该商户：防止 A 商户拿自己的密钥查 B 商户的订单
    if (order.user_id !== pid) {
        return { ok: false, code: -4, msg: '订单不存在', status: 403 };
    }

    return { ok: true };
}

/**
 * 发起支付 - API 模式
 * POST /api/pay/submit
 */
payRouter.post('/submit', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    const requestMeta = getRequestLogMeta(c.req.raw);
    
    // 获取参数
    const pid = body.pid as string;
    const type = body.type as string;
    const outTradeNo = body.out_trade_no as string;
    const notifyUrl = (body.notify_url as string) || '';
    const returnUrl = (body.return_url as string) || '';
    const name = body.name as string;
    const money = body.money as string;
    const sign = body.sign as string;
    // sign_type 由服务端按商户密钥记录决定，客户端传入的 sign_type 不参与验签
    //
    // 注意：`as string` 只是编译期断言，不传时运行时仍是 undefined，
    // 直接 bind 给 D1 会抛 D1_TYPE_ERROR（Type 'undefined' not supported）→ 500。
    // 开发者 API 下单时 clientip / param / return_url 都是可选参数，必须给默认值。
    const param = (body.param as string) || '';
    const clientIp = (body.clientip as string) || '127.0.0.1';
    const device = (body.device as string) || 'pc';
    
    // 参数验证
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!type) return c.json({ code: -1, msg: '支付方式不能为空' });
    if (!outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!notifyUrl) return c.json({ code: -1, msg: '通知地址不能为空' });
    if (!name) return c.json({ code: -1, msg: '商品名称不能为空' });
    if (!money) return c.json({ code: -1, msg: '金额不能为空' });
    if (!sign) return c.json({ code: -1, msg: '签名不能为空' });
    
    const amount = parseFloat(money);
    if (isNaN(amount) || amount <= 0) {
        return c.json({ code: -1, msg: '金额不合法' });
    }

    // 异步通知地址出站安全校验 (防止 SSRF)
    const notifyUrlGuard = await isSafeOutboundUrl(notifyUrl);
    if (!notifyUrlGuard.ok) {
        return c.json({ code: -1, msg: '通知地址不合法' });
    }
    
    // 订单号格式验证
    if (!/^[a-zA-Z0-9.\_\-|]+$/.test(outTradeNo)) {
        return c.json({ code: -1, msg: '订单号格式不正确' });
    }
    
    try {
        // 验证签名（密钥来源统一为 api_keys 表，支持商户配置多把密钥）
        const auth = await authorizeSignedRequest(env.DB, {
            pid,
            sign,
            requireTimestamp: false,
            params: {
                type,
                out_trade_no: outTradeNo,
                notify_url: notifyUrl,
                name,
                money,
                param: param || '',
            },
        });
        if (!auth.ok) return c.json({ code: auth.code, msg: auth.msg });
        
        // 检查订单是否已存在
        const existingOrder = await env.DB.prepare(
            'SELECT * FROM orders WHERE user_id = ? AND out_trade_no = ?'
        ).bind(pid, outTradeNo).first();
        
        if (existingOrder) {
            if (existingOrder.status === 1) {
                return c.json({ code: -1, msg: '该订单已完成支付，请勿重复发起' });
            }
            // 返回已有订单
            const siteUrl = await getSiteUrl(env, c.req.url);
            return c.json({
                code: 1,
                msg: '创建订单成功',
                trade_no: existingOrder.id,
                payurl: `${siteUrl}/cashier/${existingOrder.id}`
            });
        }
        
        // 获取支付通道
        const channel = await env.DB.prepare(
            'SELECT * FROM channels WHERE payment_type_id = ? AND status = 1 ORDER BY sort_order LIMIT 1'
        ).bind(type).first();
        
        if (!channel) {
            return c.json({ code: -1, msg: '暂不支持该支付方式' });
        }
        
        // 创建订单
        const tradeNo = generateUUIDv7();
        const now = new Date().toISOString();
        
        await env.DB.prepare(`
            INSERT INTO orders (
                id, user_id, out_trade_no, payment_type, channel_id, 
                plugin, amount, status, name, param, 
                notify_url, return_url, buyer_ip, domain, device,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            tradeNo, pid, outTradeNo, type, channel.id,
            channel.plugin, amount, 0, name, param,
            notifyUrl, returnUrl, clientIp, '', device,
            now
        ).run();

        await logOrderEvent(env, {
            orderId: tradeNo,
            userId: pid,
            outTradeNo,
            action: 'created',
            toStatus: 0,
            amount,
            detail: { source: 'api_submit', payment_type: type, channel_id: channel.id, plugin: channel.plugin, device },
            ...requestMeta,
        });
        
        // 获取支付插件
        const plugin = getPlugin(channel.plugin);
        
        // 调用插件创建支付
        const channelConfig = await decryptChannelConfig(channel.config, env.ENCRYPTION_KEY);
        const siteUrl = await getSiteUrl(env, c.req.url);
        const defaultNotifyUrl = `${siteUrl}/notify/${channel.plugin}`;
        console.log('[Pay/submit] notify_url:', channelConfig.notifyUrl || defaultNotifyUrl);
        const payResult = await plugin.createPayment(
            {
                tradeNo,
                outTradeNo,
                amount,
                actualAmount: amount,
                subject: name,
                clientIp: clientIp || '127.0.0.1',
                createdAt: now
            },
            {
                // 先展开通道配置，再用显式字段覆盖。
                // 原写法把 ...channelConfig 放最后，通道配置里的 returnUrl 会盖掉
                // 开发者下单时传入的 return_url —— 回跳地址必须以下单参数为准。
                ...channelConfig,
                appId: channelConfig.appId || '',
                appSecret: channelConfig.appSecret || '',
                notifyUrl: channelConfig.notifyUrl || defaultNotifyUrl,
                // 优先级：开发者下单传入 > 通道配置兜底 > 平台结果页
                returnUrl: returnUrl || channelConfig.returnUrl || `${siteUrl}/cashier/${tradeNo}`,
            }
        );

        await logPaymentEvent(env, {
            orderId: tradeNo,
            userId: pid,
            channelId: channel.id,
            plugin: channel.plugin,
            direction: 'response',
            action: 'create_payment',
            status: payResult.success ? 'success' : 'failed',
            amount,
            requestData: { out_trade_no: outTradeNo, payment_type: type, subject: name },
            responseData: {
                method: payResult.method,
                has_pay_url: Boolean(payResult.payUrl),
                has_qrcode: Boolean(payResult.qrcode || payResult.qrcodeUrl),
                message: payResult.message || '',
            },
            errorMessage: payResult.success ? null : payResult.message || '创建支付失败',
        });
        
        if (!payResult.success) {
            return c.json({ code: -1, msg: payResult.message || '创建支付失败' });
        }
        
        return c.json({
            code: 1,
            msg: '创建订单成功',
            trade_no: tradeNo,
            payurl: payResult.payUrl || `${siteUrl}/cashier/${tradeNo}`,
            qrcode: payResult.qrcode
        });
    } catch (error) {
        console.error('Create payment error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 收银台下单
 * POST /api/pay/cashier
 *
 * 认证方式（二选一）：
 *  A. 收银台页面模式：携带服务端签发的 ticket + 以 ticket 为密钥的 sign
 *  B. 商户服务端直连：不带 ticket，直接以商户 API 密钥签名
 *
 * 两者都要求 sign = HMAC-SHA256(key, amount=<>&merchant_id=<>&timestamp=<>&type=<>[&name=<>])，
 * 且 timestamp 与服务器时间偏差在 5 分钟内，防止重放。
 */
payRouter.post('/cashier', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    const requestMeta = getRequestLogMeta(c.req.raw);

    const merchantId = body.merchant_id as string;
    const amountStr = body.amount as string;
    const type = body.type as string;
    const name = body.name as string || '在线收银台付款';
    const ticket = body.ticket as string;
    const timestamp = body.timestamp as string;
    const sign = body.sign as string;

    if (!merchantId) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!amountStr) return c.json({ code: -1, msg: '金额不能为空' });
    if (!type) return c.json({ code: -1, msg: '支付方式不能为空' });
    if (!timestamp) return c.json({ code: -1, msg: '时间戳不能为空' });
    if (!sign) return c.json({ code: -1, msg: '签名不能为空' });

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount < 0.01) {
        return c.json({ code: -1, msg: '金额不合法' });
    }

    // 时间戳新鲜度校验（放重放）
    if (!isTimestampFresh(timestamp)) {
        return c.json({ code: -2, msg: '请求已过期，请刷新收银台页面' });
    }

    try {
        const user = await env.DB.prepare(
            'SELECT id, status, notify_url, return_url FROM users WHERE id = ? AND role = ?'
        ).bind(merchantId, 'merchant').first();

        if (!user) return c.json({ code: -3, msg: '商户不存在' });
        if (user.status !== 1) return c.json({ code: -2, msg: '商户已被封禁' });

        // 主密钥统一经 getPrimaryApiKey 取（api_keys 表 status = 1 中创建时间最早的一条），
        // 与收银台票据签发、出站通知签名口径一致
        const primaryKey = await getPrimaryApiKey(env.DB, merchantId);

        if (!primaryKey) return c.json({ code: -3, msg: '商户未配置 API 密钥' });

        const apiKey = primaryKey.api_key;

        // 1) 票据校验（收银台页面模式）
        let signingKey = apiKey;
        if (ticket) {
            const ticketPayload = await verifyCashierTicket(ticket, apiKey);
            if (!ticketPayload) {
                return c.json({ code: -2, msg: '收银台票据无效或已过期' });
            }
            // 票据与下单商户必须一致，防止一张票据给任意商户下单
            if (ticketPayload.merchantId !== merchantId) {
                return c.json({ code: -2, msg: '收银台票据与商户不匹配' });
            }
            signingKey = ticket;
        }

        // 2) 下单签名校验
        const signParams = {
            merchant_id: merchantId,
            amount: amount.toFixed(2),
            type,
            timestamp,
            name,
        };
        const isValidSign = await verifyCashierSign(signParams, signingKey, sign);
        if (!isValidSign) {
            return c.json({ code: -2, msg: '签名验证失败' });
        }

        const channel = await env.DB.prepare(
            'SELECT * FROM channels WHERE payment_type_id = ? AND status = 1 ORDER BY sort_order LIMIT 1'
        ).bind(type).first();

        if (!channel) return c.json({ code: -1, msg: '暂不支持该支付方式' });

        const tradeNo = generateUUIDv7();
        const outTradeNo = 'CASHIER' + Date.now();
        const now = new Date().toISOString();
        const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '127.0.0.1';

        await env.DB.prepare(`
            INSERT INTO orders (
                id, user_id, out_trade_no, payment_type, channel_id,
                plugin, amount, status, name, param,
                notify_url, return_url, buyer_ip, domain, device,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            tradeNo, merchantId, outTradeNo, type, channel.id,
            channel.plugin, amount, 0, name, '',
            user.notify_url || '', user.return_url || '', clientIp, '', 'cashier',
            now
        ).run();

        await logOrderEvent(env, {
            orderId: tradeNo,
            userId: merchantId,
            outTradeNo,
            action: 'created',
            toStatus: 0,
            amount,
            detail: { source: 'cashier', payment_type: type, channel_id: channel.id, plugin: channel.plugin },
            ...requestMeta,
        });

        const plugin = getPlugin(channel.plugin);

        const channelConfig = await decryptChannelConfig(channel.config, env.ENCRYPTION_KEY);
        const siteUrl = await getSiteUrl(env, c.req.url);
        const defaultNotifyUrl = `${siteUrl}/notify/${channel.plugin}`;
        console.log('[Pay/cashier] notify_url:', channelConfig.notifyUrl || user.notify_url || defaultNotifyUrl);
        const payResult = await plugin.createPayment(
            {
                tradeNo,
                outTradeNo,
                amount,
                actualAmount: amount,
                subject: name,
                clientIp,
                createdAt: now
            },
            {
                // 同 /submit：展开放前面，避免通道配置覆盖显式回跳地址
                ...channelConfig,
                appId: channelConfig.appId || '',
                appSecret: channelConfig.appSecret || '',
                notifyUrl: channelConfig.notifyUrl || user.notify_url || defaultNotifyUrl,
                // 优先级：商户配置 > 通道配置兜底 > 平台结果页
                returnUrl: user.return_url || channelConfig.returnUrl || `${siteUrl}/cashier/${tradeNo}`,
            }
        );

        await logPaymentEvent(env, {
            orderId: tradeNo,
            userId: merchantId,
            channelId: channel.id,
            plugin: channel.plugin,
            direction: 'response',
            action: 'create_payment',
            status: payResult.success ? 'success' : 'failed',
            amount,
            requestData: { out_trade_no: outTradeNo, payment_type: type, subject: name },
            responseData: {
                method: payResult.method,
                has_pay_url: Boolean(payResult.payUrl),
                has_qrcode: Boolean(payResult.qrcode || payResult.qrcodeUrl),
                message: payResult.message || '',
            },
            errorMessage: payResult.success ? null : payResult.message || '创建支付失败',
        });

        if (!payResult.success) {
            return c.json({ code: -1, msg: payResult.message || '创建支付失败' });
        }

        return c.json({
            code: 1,
            msg: '创建订单成功',
            trade_no: tradeNo,
            payurl: payResult.payUrl || `${siteUrl}/cashier/${tradeNo}`,
            qrcode: payResult.qrcode
        });
    } catch (error) {
        console.error('Cashier payment error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询订单状态（订单维度受限接口，供收银台轮询，会主动查询支付渠道）
 * GET /api/pay/status/:tradeNo
 *
 * 认证（二选一，B-3 整改）：
 *   A. 订单票据：收银台页面 URL / 响应头 `X-Order-Token` 携带的单订单凭证，
 *      由 `GET /cashier/:tradeNo` 服务端签发，只能查这一个单号。
 *   B. 商户签名：`pid` + `trade_no` + `timestamp` + `sign`（服务端直连场景）。
 *
 * 整改前该接口无任何校验，任何人拿到平台订单号即可查询订单状态与金额；
 * 订单号会出现在收银台 URL 与商户回跳地址中，等同于半公开信息。
 */
payRouter.get('/status/:tradeNo', async (c) => {
    const { tradeNo } = c.req.param();
    const env = c.env;

    try {
        const order = await env.DB.prepare(
            'SELECT * FROM orders WHERE id = ?'
        ).bind(tradeNo).first() as any;

        if (!order) {
            return c.json({ code: -1, msg: '订单不存在' });
        }

        // 认证：订单票据（页面轮询）或商户签名（服务端直连）
        const authorized = await authorizeOrderStatusRequest(c, env, order);
        if (!authorized.ok) {
            return c.json({ code: authorized.code, msg: authorized.msg }, authorized.status);
        }

        // 如果订单未支付，主动查询支付渠道
        if (order.status === 0 && order.plugin && order.channel_id) {
            try {
                const channel = await env.DB.prepare(
                    'SELECT * FROM channels WHERE id = ? AND status = 1'
                ).bind(order.channel_id).first() as any;

                if (channel) {
                    const plugin = getPlugin(order.plugin);
                    const channelConfig = await decryptChannelConfig(channel.config, env.ENCRYPTION_KEY);
                    const orderStatus = await plugin.queryOrder(tradeNo, {
                        appId: channelConfig.appId || '',
                        appSecret: channelConfig.appSecret || '',
                        ...channelConfig
                    });

                    await logPaymentEvent(env, {
                        orderId: tradeNo,
                        userId: order.user_id,
                        channelId: order.channel_id,
                        plugin: order.plugin,
                        direction: 'response',
                        action: 'query_order',
                        status: orderStatus.status === 'paid' ? 'success' : orderStatus.status,
                        amount: order.amount,
                        thirdPartyTradeNo: orderStatus.thirdPartyTradeNo || null,
                        responseData: orderStatus,
                    });

                    // 如果查询到已支付，更新订单状态
                    if (orderStatus.status === 'paid') {
                        // 轮询路径与回调路径共用同一个入账单元：
                        // 金额核对 -> UPDATE orders ... WHERE id=? AND status=0 状态翻转 CAS
                        // -> meta.changes>0 才在单个 D1 事务(batch)里加余额与统计，
                        // 因此「回调 + 轮询」并发也只会入账一次。
                        const credit = await creditOrder(
                            env,
                            order as OrderRow,
                            {
                                tradeNo,
                                thirdPartyTradeNo: orderStatus.thirdPartyTradeNo,
                                buyer: orderStatus.buyer,
                                paidAt: orderStatus.paidAt,
                                paidAmount: orderStatus.paidAmount,
                            },
                            CREDIT_SOURCE.STATUS_POLL
                        );

                        if (credit.outcome === CREDIT_OUTCOME.CREDITED || credit.outcome === CREDIT_OUTCOME.DUPLICATE) {
                            // DUPLICATE = 已被回调/其它轮询入账，只回报状态，绝不重复加钱
                            return c.json({
                                code: 1,
                                status: 1,
                                msg: '已支付'
                            });
                        }

                        if (credit.outcome === CREDIT_OUTCOME.AMOUNT_MISMATCH) {
                            // 渠道报已支付但实付金额与订单不一致：拒绝入账，订单保持未支付等待对账
                            console.error(`[Pay/status] amount mismatch, credit rejected: ${tradeNo} (${credit.reason})`);
                            return c.json({
                                code: 1,
                                status: order.status,
                                msg: '未支付'
                            });
                        }

                        // 数据库异常：本次不入账，等渠道重试回调时再来一次
                        console.error(`[Pay/status] credit transaction failed: ${tradeNo} (${credit.reason})`);
                        return c.json({
                            code: 1,
                            status: order.status,
                            msg: '未支付'
                        });
                    }
                }
            } catch (e) {
                await logPaymentEvent(env, {
                    orderId: tradeNo,
                    userId: order.user_id,
                    channelId: order.channel_id,
                    plugin: order.plugin,
                    direction: 'response',
                    action: 'query_order',
                    status: 'error',
                    amount: order.amount,
                    errorMessage: e instanceof Error ? e.message : String(e),
                });
                console.error('[Pay/status] queryOrder error:', e);
            }
        }

        return c.json({
            code: 1,
            status: order.status,
            msg: order.status === 1 ? '已支付' : order.status === 2 ? '已退款' : order.status === 3 ? '已关闭' : '未支付'
        });
    } catch (error) {
        console.error('Status query error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询订单
 * GET /api/pay/query
 */
payRouter.get('/query', async (c) => {
    const env = c.env;
    const pid = c.req.query('pid');
    const tradeNo = c.req.query('trade_no');
    const outTradeNo = c.req.query('out_trade_no');
    const sign = c.req.query('sign');
    const timestamp = c.req.query('timestamp');
    // 明文密钥不再从 URL query 读取：只认 sign 签名或请求头（Authorization / X-API-Key）
    const headerKey = readApiKeyFromHeaders(c.req.raw.headers);
    // sign_type 不再从客户端读取，统一由服务端密钥记录决定
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!tradeNo && !outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!sign && !headerKey) return c.json({ code: -1, msg: '缺少验证参数' });
    
    try {
        // 验证签名或请求头密钥（密钥来源统一为 api_keys 表）
        if (sign) {
            const auth = await authorizeSignedRequest(env.DB, {
                pid,
                sign,
                timestamp,
                params: {
                    ...(tradeNo ? { trade_no: tradeNo } : {}),
                    ...(outTradeNo ? { out_trade_no: outTradeNo } : {}),
                },
            });
            if (!auth.ok) return c.json({ code: auth.code, msg: auth.msg });
        } else {
            const matched = await matchApiKey(env.DB, pid, headerKey);
            if (!matched) {
                return c.json({ code: -3, msg: '商户不存在或密钥错误' });
            }
        }
        
        // 查询订单
        let order;
        if (tradeNo) {
            order = await env.DB.prepare(
                'SELECT * FROM orders WHERE id = ? AND user_id = ?'
            ).bind(tradeNo, pid).first();
        } else {
            order = await env.DB.prepare(
                'SELECT * FROM orders WHERE out_trade_no = ? AND user_id = ?'
            ).bind(outTradeNo, pid).first();
        }
        
        if (!order) {
            return c.json({ code: -4, msg: '订单不存在' });
        }
        
        // 获取支付方式名称
        // orders.payment_type 存的是 payment_types.id（如 pt_wxpay），历史数据可能存 name（如 wxpay），两种都兼容
        const paymentType = await env.DB.prepare(
            'SELECT display_name FROM payment_types WHERE id = ? OR name = ?'
        ).bind(order.payment_type, order.payment_type).first();
        
        return c.json({
            code: 1,
            msg: 'succ',
            trade_no: order.id,
            out_trade_no: order.out_trade_no,
            api_trade_no: order.api_trade_no,
            type: paymentType?.display_name || order.payment_type,
            pid: order.user_id,
            name: order.name,
            money: order.amount.toFixed(2),
            param: order.param,
            buyer: order.buyer,
            status: order.status,
            addtime: order.created_at,
            endtime: order.paid_at
        });
    } catch (error) {
        console.error('Query order error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 批量查询订单
 * GET /api/pay/orders
 */
payRouter.get('/orders', async (c) => {
    const env = c.env;
    const pid = c.req.query('pid');
    const sign = c.req.query('sign');
    const timestamp = c.req.query('timestamp');
    const limit = parseInt(c.req.query('limit') || '10');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    // 明文密钥不再从 URL query 读取（原实现把 key 直接放 URL，会泄露到日志/CDN/Referer）
    const headerKey = readApiKeyFromHeaders(c.req.raw.headers);
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!sign && !headerKey) return c.json({ code: -1, msg: '缺少验证参数：请使用 sign 签名或请求头密钥' });
    
    try {
        // 验证签名或请求头密钥（密钥来源统一为 api_keys 表）
        if (sign) {
            const auth = await authorizeSignedRequest(env.DB, {
                pid,
                sign,
                timestamp,
                params: {
                    limit: String(limit),
                    offset: String(offset),
                    ...(status !== undefined ? { status: String(status) } : {}),
                },
            });
            if (!auth.ok) return c.json({ code: auth.code, msg: auth.msg });
        } else {
            const matched = await matchApiKey(env.DB, pid, headerKey);
            if (!matched) {
                return c.json({ code: -3, msg: '商户不存在或密钥错误' });
            }
        }
        
        // 构建查询
        let query = 'SELECT o.*, pt.display_name as type_name FROM orders o LEFT JOIN payment_types pt ON o.payment_type = pt.id OR o.payment_type = pt.name WHERE o.user_id = ?';
        const params: any[] = [pid];
        
        if (status !== undefined) {
            query += ' AND o.status = ?';
            params.push(parseInt(status));
        }
        
        query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
        params.push(Math.min(limit, 50), offset);
        
        const orders = await env.DB.prepare(query).bind(...params).all();
        
        // 查询总数
        let countQuery = 'SELECT COUNT(*) as total FROM orders WHERE user_id = ?';
        const countParams: any[] = [pid];
        if (status !== undefined) {
            countQuery += ' AND status = ?';
            countParams.push(parseInt(status));
        }
        const countResult = await env.DB.prepare(countQuery).bind(...countParams).first();
        
        return c.json({
            code: 1,
            msg: '查询订单记录成功！',
            count: countResult?.total || 0,
            data: orders.results.map((order: any) => ({
                trade_no: order.id,
                out_trade_no: order.out_trade_no,
                type: order.type_name || order.payment_type,
                pid: order.user_id,
                name: order.name,
                money: order.amount.toFixed(2),
                status: order.status,
                addtime: order.created_at,
                endtime: order.paid_at
            }))
        });
    } catch (error) {
        console.error('Query orders error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 退款渠道上下文：退款必须打给真实支付渠道，缺一不可
 */
interface RefundChannelContext {
    plugin: ReturnType<typeof getPlugin>;
    config: PluginConfig;
    channelId: string | null;
    pluginId: string;
}

/**
 * 解析订单对应的支付渠道与插件配置（B-2 前置条件）
 *
 * 拿不到渠道 / 插件 / 配置时返回错误，调用方必须拒绝退款，
 * 不能像整改前那样「只写库就告诉商户退款成功」。
 */
async function resolveRefundChannel(env: Env, order: any): Promise<{ ok: true; ctx: RefundChannelContext } | { ok: false; msg: string }> {
    const pluginId = order.plugin;
    if (!pluginId) {
        return { ok: false, msg: '订单未记录支付渠道，无法向渠道发起退款' };
    }

    let plugin: ReturnType<typeof getPlugin>;
    try {
        plugin = getPlugin(pluginId);
    } catch {
        return { ok: false, msg: `支付渠道插件不存在: ${pluginId}` };
    }

    let config: Record<string, any> = {};
    let channelId: string | null = order.channel_id || null;
    if (channelId) {
        const channel = await env.DB.prepare(
            'SELECT * FROM channels WHERE id = ?'
        ).bind(channelId).first() as any;

        if (channel) {
            // 渠道被停用也要能退款：买家已经付过钱，退款不该受运营开关影响
            config = await decryptChannelConfig(channel.config, env.ENCRYPTION_KEY);
        } else {
            channelId = null;
        }
    }

    if (!config.appId && !config.appSecret && !config.mchId) {
        return { ok: false, msg: '支付渠道配置缺失，无法向渠道发起退款' };
    }

    return {
        ok: true,
        ctx: {
            plugin,
            config: {
                ...config,
                appId: config.appId || '',
                appSecret: config.appSecret || '',
            },
            channelId,
            pluginId,
        },
    };
}

/**
 * 回滚「退款占位」：CAS 累加的 refund_amount 与翻转的订单状态
 *
 * 只在渠道退款失败时调用。refund_amount 按金额回退，
 * 订单状态仅在累计退款额归零时由 2 回退为 1，避免误伤其它退款记录。
 */
async function rollbackRefundReservation(env: Env, orderId: string, amount: number): Promise<void> {
    try {
        await env.DB.prepare(
            `UPDATE orders SET refund_amount = refund_amount - ? WHERE id = ? AND refund_amount >= ?`
        ).bind(amount, orderId, amount).run();

        await env.DB.prepare(
            `UPDATE orders SET status = 1 WHERE id = ? AND status = 2 AND refund_amount <= 0`
        ).bind(orderId).run();
    } catch (error) {
        // 回滚失败必须留痕：此时库里存在「退款占位未释放」的悬空状态，需人工对账
        console.error(`[Pay/refund] 退款占位回滚失败，需人工对账 order=${orderId} amount=${amount}:`, error);
    }
}
payRouter.post('/refund', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    const requestMeta = getRequestLogMeta(c.req.raw);
    
    const pid = body.pid as string;
    const tradeNo = body.trade_no as string;
    const outTradeNo = body.out_trade_no as string;
    const amount = body.money as string;
    const sign = body.sign as string;
    // 明文密钥只接受 POST body 与请求头，URL query 中的 key 不再参与认证
    const key = (body.key as string) || readApiKeyFromHeaders(c.req.raw.headers);
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!tradeNo && !outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!amount) return c.json({ code: -1, msg: '退款金额不能为空' });
    if (!key && !sign) return c.json({ code: -1, msg: '缺少验证参数' });
    
    const refundAmount = parseFloat(amount);
    if (isNaN(refundAmount) || refundAmount <= 0) {
        return c.json({ code: -1, msg: '退款金额不合法' });
    }
    
    try {
        // 验证密钥或签名（密钥来源统一为 api_keys 表）
        const auth = await authorizeKeyOrSign(env.DB, {
            pid,
            key,
            sign,
            params: {
                money: amount,
                ...(tradeNo ? { trade_no: tradeNo } : {}),
                ...(outTradeNo ? { out_trade_no: outTradeNo } : {}),
            },
        });
        if (!auth.ok) return c.json({ code: auth.code, msg: auth.msg });
        
        // 查询订单
        let order;
        if (tradeNo) {
            order = await env.DB.prepare(
                'SELECT * FROM orders WHERE id = ? AND user_id = ?'
            ).bind(tradeNo, pid).first();
        } else {
            order = await env.DB.prepare(
                'SELECT * FROM orders WHERE out_trade_no = ? AND user_id = ?'
            ).bind(outTradeNo, pid).first();
        }
        
        if (!order) {
            return c.json({ code: -4, msg: '订单不存在' });
        }
        
        if (order.status !== 1) {
            return c.json({ code: -1, msg: '订单状态不允许退款' });
        }
        
        const remainingRefundAmount = order.amount - (order.refund_amount || 0);
        if (refundAmount > remainingRefundAmount) {
            return c.json({ code: -1, msg: '退款金额超过可退金额' });
        }
        
        // 退款单号（渠道受理成功后才落库，避免留下「从未向渠道发起」的退款记录）
        const refundNo = generateUUIDv7();
        const isFullRefund = refundAmount >= remainingRefundAmount;

        // 先解析真实支付渠道：解析不出来就不允许进入退款流程。
        // 整改前是「先写库再返回退款成功」，渠道从未收到退款请求（B-2），
        // 商户看到成功、买家却收不到钱。现在渠道不可达即拒绝，不留悬空成功态。
        const channelCtx = await resolveRefundChannel(env, order);
        if (!channelCtx.ok) {
            return c.json({ code: -1, msg: channelCtx.msg });
        }

        // 占位：CAS 累加 refund_amount / 翻转状态，占住可退额度，防止并发超额退款
        // 并发退款 / 重复回调时，只有抢到这次 CAS 的请求才继续，其余 changes=0 直接拒绝
        const accum = await env.DB.prepare(
            `UPDATE orders SET refund_amount = refund_amount + ? WHERE id = ? AND status = 1 AND refund_amount + ? <= amount`
        ).bind(refundAmount, order.id, refundAmount).run();

        if ((accum?.meta?.changes ?? 0) <= 0) {
            return c.json({ code: -1, msg: '订单状态已变更或退款金额超出可退金额，请刷新后重试' });
        }

        // 全额退款时翻转订单状态（CAS：仅 status=1 → 2）
        if (isFullRefund) {
            await env.DB.prepare(
                'UPDATE orders SET status = 2 WHERE id = ? AND status = 1'
            ).bind(order.id).run();
        }

        // 真正调用支付渠道退款接口（B-2）：渠道失败即回滚占位并报错，
        // 绝不在渠道未受理的情况下告诉商户「退款成功」
        let refundResult: RefundResult;
        try {
            refundResult = await channelCtx.ctx.plugin.refund(
                {
                    tradeNo: order.id,
                    outTradeNo: order.out_trade_no,
                    amount: order.amount,
                    actualAmount: order.actual_amount ?? order.amount,
                    subject: order.name || '',
                    clientIp: order.buyer_ip || '',
                    createdAt: order.created_at,
                },
                refundAmount,
                channelCtx.ctx.config
            );
        } catch (error) {
            refundResult = {
                success: false,
                message: error instanceof Error ? error.message : '渠道退款请求异常',
            };
        }

        if (!refundResult.success) {
            const failMessage = refundResult.message || '渠道退款失败';
            await rollbackRefundReservation(env, order.id, refundAmount);

            await logOrderEvent(env, {
                orderId: order.id,
                userId: pid,
                outTradeNo: order.out_trade_no,
                action: 'refund_failed',
                fromStatus: 1,
                toStatus: 1,
                amount: refundAmount,
                detail: { refund_no: refundNo, reason: failMessage, plugin: channelCtx.ctx.pluginId },
                ...requestMeta,
            });

            await logPaymentEvent(env, {
                orderId: order.id,
                userId: pid,
                channelId: channelCtx.ctx.channelId,
                plugin: channelCtx.ctx.pluginId,
                direction: 'response',
                action: 'refund',
                status: 'failed',
                amount: refundAmount,
                requestData: { refund_no: refundNo, reason: body.reason || '' },
                errorMessage: failMessage,
            });

            return c.json({ code: -1, msg: `退款失败：${failMessage}` });
        }

        // 渠道已受理：落退款记录。渠道未回传第三方退款号时记为处理中（0），
        // 最终状态由 /api/pay/refund/query 对账补齐。
        const settledAt = new Date().toISOString();
        await env.DB.prepare(`
            INSERT INTO refunds (id, refund_no, order_id, user_id, amount, reason, status, third_party_refund_no, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            refundNo, refundNo, order.id, pid, refundAmount,
            (body.reason as string) || '',
            refundResult.thirdPartyRefundNo ? 1 : 0,
            refundResult.thirdPartyRefundNo || null,
            settledAt,
            refundResult.thirdPartyRefundNo ? settledAt : null
        ).run();

        await logOrderEvent(env, {
            orderId: order.id,
            userId: pid,
            outTradeNo: order.out_trade_no,
            action: 'refund_requested',
            fromStatus: 1,
            toStatus: isFullRefund ? 2 : 1,
            amount: refundAmount,
            detail: {
                refund_no: refundNo,
                remaining_before_refund: remainingRefundAmount,
                third_party_refund_no: refundResult.thirdPartyRefundNo || null,
                plugin: channelCtx.ctx.pluginId,
            },
            ...requestMeta,
        });

        await logPaymentEvent(env, {
            orderId: order.id,
            userId: pid,
            channelId: channelCtx.ctx.channelId,
            plugin: channelCtx.ctx.pluginId,
            direction: 'response',
            action: 'refund',
            status: 'success',
            amount: refundAmount,
            requestData: { refund_no: refundNo, reason: body.reason || '' },
            responseData: {
                refund_no: refundResult.refundNo || refundNo,
                third_party_refund_no: refundResult.thirdPartyRefundNo || null,
            },
        });

        return c.json({
            code: 1,
            msg: `退款成功！退款金额¥${refundAmount.toFixed(2)}`,
            refund_no: refundNo,
            trade_no: order.id,
            money: refundAmount,
            // 渠道异步退款时不会立即回传第三方退款号，此时记录状态为处理中
            status: refundResult.thirdPartyRefundNo ? 1 : 0
        });
    } catch (error) {
        console.error('Refund error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询退款记录
 * GET /api/pay/refund/query
 *
 * 安全整改：原实现只校验 pid + 单号，任何人拿到商户 ID 后即可枚举退款记录
 * （金额、状态、时间），属于越权信息泄露。现要求与退款申请同一套 sign 机制
 * （pid + 业务参数 + timestamp 时间戳，密钥取自 api_keys 表），
 * 也接受请求头明文密钥（Authorization / X-API-Key），URL query 中的 key 不再接受。
 */
payRouter.get('/refund/query', async (c) => {
    const env = c.env;
    const pid = c.req.query('pid');
    const refundNo = c.req.query('refund_no');
    const outTradeNo = c.req.query('out_trade_no');
    const sign = c.req.query('sign');
    const timestamp = c.req.query('timestamp');
    const headerKey = readApiKeyFromHeaders(c.req.raw.headers);
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!refundNo && !outTradeNo) return c.json({ code: -1, msg: '退款单号不能为空' });
    if (!sign && !headerKey) return c.json({ code: -1, msg: '缺少验证参数' });
    
    try {
        // 认证：签名（含时间戳防重放）或请求头明文密钥
        if (sign) {
            const auth = await authorizeSignedRequest(env.DB, {
                pid,
                sign,
                timestamp,
                params: {
                    ...(refundNo ? { refund_no: refundNo } : {}),
                    ...(outTradeNo ? { out_trade_no: outTradeNo } : {}),
                },
            });
            if (!auth.ok) return c.json({ code: auth.code, msg: auth.msg });
        } else {
            const matched = await matchApiKey(env.DB, pid, headerKey);
            if (!matched) return c.json({ code: -3, msg: '商户不存在或密钥错误' });
        }
        
        let refund;
        if (refundNo) {
            refund = await env.DB.prepare(`
                SELECT r.*, o.out_trade_no FROM refunds r
                LEFT JOIN orders o ON r.order_id = o.id
                WHERE r.refund_no = ? AND r.user_id = ?
            `).bind(refundNo, pid).first();
        } else {
            refund = await env.DB.prepare(`
                SELECT r.*, o.out_trade_no FROM refunds r
                LEFT JOIN orders o ON r.order_id = o.id
                WHERE o.out_trade_no = ? AND r.user_id = ?
            `).bind(outTradeNo, pid).first();
        }
        
        if (!refund) {
            return c.json({ code: -4, msg: '退款记录不存在' });
        }
        
        return c.json({
            code: 1,
            refund_no: refund.refund_no,
            out_trade_no: refund.out_trade_no,
            trade_no: refund.order_id,
            money: refund.amount,
            status: refund.status,
            addtime: refund.created_at,
            endtime: refund.completed_at
        });
    } catch (error) {
        console.error('Query refund error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 关闭订单
 * POST /api/pay/close
 */
payRouter.post('/close', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    const requestMeta = getRequestLogMeta(c.req.raw);
    
    const pid = body.pid as string;
    const tradeNo = body.trade_no as string;
    const outTradeNo = body.out_trade_no as string;
    const sign = body.sign as string;
    // 明文密钥只接受 POST body 与请求头，URL query 中的 key 不再参与认证
    const key = (body.key as string) || readApiKeyFromHeaders(c.req.raw.headers);
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!tradeNo && !outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!key && !sign) return c.json({ code: -1, msg: '缺少验证参数' });
    
    try {
        // 验证密钥或签名（密钥来源统一为 api_keys 表）
        const auth = await authorizeKeyOrSign(env.DB, {
            pid,
            key,
            sign,
            params: {
                ...(tradeNo ? { trade_no: tradeNo } : {}),
                ...(outTradeNo ? { out_trade_no: outTradeNo } : {}),
            },
        });
        if (!auth.ok) return c.json({ code: auth.code, msg: auth.msg });
        
        // 查询订单
        let order;
        if (tradeNo) {
            order = await env.DB.prepare(
                'SELECT * FROM orders WHERE id = ? AND user_id = ?'
            ).bind(tradeNo, pid).first();
        } else {
            order = await env.DB.prepare(
                'SELECT * FROM orders WHERE out_trade_no = ? AND user_id = ?'
            ).bind(outTradeNo, pid).first();
        }
        
        if (!order) {
            return c.json({ code: -4, msg: '订单不存在' });
        }
        
        if (order.status !== 0) {
            return c.json({ code: -1, msg: '订单状态不允许关闭' });
        }
        
        // 关闭订单
        const now = new Date().toISOString();
        await env.DB.prepare(
            'UPDATE orders SET status = 3, closed_at = ? WHERE id = ?'
        ).bind(now, order.id).run();

        await logOrderEvent(env, {
            orderId: order.id,
            userId: pid,
            outTradeNo: order.out_trade_no,
            action: 'closed',
            fromStatus: 0,
            toStatus: 3,
            amount: order.amount,
            detail: { source: 'api_close' },
            ...requestMeta,
        });
        
        // B-1：成功码统一为 1（与 submit / query / orders 一致），
        // 此前本接口与 refund 返回 0 表示成功，与 docs/api.md 的「0=失败」矛盾
        return c.json({
            code: 1,
            msg: '订单关闭成功',
            trade_no: order.id
        });
    } catch (error) {
        console.error('Close order error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 获取支持的支付方式
 * GET /api/pay/types
 */
payRouter.get('/types', async (c) => {
    const env = c.env;

    try {
        // 查询所有启用的支付方式
        const paymentTypes = await env.DB.prepare(
            'SELECT id, name, display_name, icon, sort_order FROM payment_types WHERE status = 1 ORDER BY sort_order ASC'
        ).all();

        return c.json({
            code: 1,
            msg: '获取支付方式列表成功',
            data: paymentTypes.results.map((type: any) => ({
                id: type.id,
                name: type.name,
                display_name: type.display_name,
                icon: type.icon,
                sort_order: type.sort_order
            }))
        });
    } catch (error) {
        console.error('Get payment types error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
