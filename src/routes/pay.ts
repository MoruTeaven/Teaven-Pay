/**
 * 支付路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { generateUUIDv7 } from '../utils/uuid';
import { resolveServerSignType, verifySignAsync } from '../utils/crypto';
import { getPlugin } from '../plugins';
import { getSiteUrl } from '../utils/site';
import { getRequestLogMeta, logOrderEvent, logPaymentEvent } from '../utils/logging';

export const payRouter = new Hono<{ Bindings: Env }>();

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
    const notifyUrl = body.notify_url as string;
    const returnUrl = body.return_url as string;
    const name = body.name as string;
    const money = body.money as string;
    const sign = body.sign as string;
    // sign_type 由服务端按商户密钥记录决定，客户端传入的 sign_type 不参与验签
    const param = body.param as string;
    const clientIp = body.clientip as string;
    const device = body.device as string || 'pc';
    
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
    
    // 订单号格式验证
    if (!/^[a-zA-Z0-9.\_\-|]+$/.test(outTradeNo)) {
        return c.json({ code: -1, msg: '订单号格式不正确' });
    }
    
    try {
        // 查询商户信息
        const user = await env.DB.prepare(
            'SELECT id, status FROM users WHERE id = ? AND role = ?'
        ).bind(pid, 'merchant').first();
        
        if (!user) {
            return c.json({ code: -3, msg: '商户不存在' });
        }
        
        if (user.status !== 1) {
            return c.json({ code: -2, msg: '商户已被封禁' });
        }
        
        // 查询商户的 API 密钥
        const apiKeyRecord = await env.DB.prepare(
            'SELECT api_key, api_key_type FROM api_keys WHERE user_id = ? AND status = 1'
        ).bind(pid).first();
        
        if (!apiKeyRecord) {
            return c.json({ code: -3, msg: '商户未配置 API 密钥' });
        }
        
        // 验证签名
        const signParams = {
            pid,
            type,
            out_trade_no: outTradeNo,
            notify_url: notifyUrl,
            name,
            money,
            param: param || ''
        };
        
        const signType = resolveServerSignType(apiKeyRecord as { api_key_type?: string | null } | null);
        const isValidSign = await verifySignAsync(signParams, (apiKeyRecord as any).api_key, sign, signType);
        if (!isValidSign) {
            return c.json({ code: -2, msg: '签名验证失败' });
        }
        
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
        const channelConfig = JSON.parse(channel.config || '{}');
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
                appId: channelConfig.appId || '',
                appSecret: channelConfig.appSecret || '',
                notifyUrl: channelConfig.notifyUrl || defaultNotifyUrl,
                returnUrl: returnUrl || `${siteUrl}/cashier/${tradeNo}`,
                ...channelConfig
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
 * 收银台下单 - 无需签名，供公开收银台页面使用
 * POST /api/pay/cashier
 */
payRouter.post('/cashier', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    const requestMeta = getRequestLogMeta(c.req.raw);

    const merchantId = body.merchant_id as string;
    const amountStr = body.amount as string;
    const type = body.type as string;
    const name = body.name as string || '在线收银台付款';

    if (!merchantId) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!amountStr) return c.json({ code: -1, msg: '金额不能为空' });
    if (!type) return c.json({ code: -1, msg: '支付方式不能为空' });

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount < 0.01) {
        return c.json({ code: -1, msg: '金额不合法' });
    }

    try {
        const user = await env.DB.prepare(
            'SELECT id, status, notify_url, return_url FROM users WHERE id = ? AND role = ?'
        ).bind(merchantId, 'merchant').first();

        if (!user) return c.json({ code: -3, msg: '商户不存在' });
        if (user.status !== 1) return c.json({ code: -2, msg: '商户已被封禁' });

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

        const channelConfig = JSON.parse(channel.config || '{}');
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
                appId: channelConfig.appId || '',
                appSecret: channelConfig.appSecret || '',
                notifyUrl: channelConfig.notifyUrl || user.notify_url || defaultNotifyUrl,
                returnUrl: user.return_url || `${siteUrl}/cashier/${tradeNo}`,
                ...channelConfig
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
 * 查询订单状态（公开接口，供收银台轮询，会主动查询支付渠道）
 * GET /api/pay/status/:tradeNo
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

        // 如果订单未支付，主动查询支付渠道
        if (order.status === 0 && order.plugin && order.channel_id) {
            try {
                const channel = await env.DB.prepare(
                    'SELECT * FROM channels WHERE id = ? AND status = 1'
                ).bind(order.channel_id).first() as any;

                if (channel) {
                    const plugin = getPlugin(order.plugin);
                    const channelConfig = JSON.parse(channel.config || '{}');
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
                        const now = new Date().toISOString();
                        await env.DB.prepare(`
                            UPDATE orders SET
                                status = 1,
                                api_trade_no = ?,
                                paid_at = ?,
                                notify_status = 0
                            WHERE id = ? AND status = 0
                        `).bind(
                            orderStatus.thirdPartyTradeNo || '',
                            orderStatus.paidAt || now,
                            tradeNo
                        ).run();

                        // 更新商户余额
                        const fee = order.fee || 0;
                        const profit = order.amount - fee;
                        await env.DB.prepare(`
                            UPDATE users SET
                                balance = balance + ?,
                                today_income = today_income + ?,
                                total_income = total_income + ?,
                                today_orders = today_orders + 1,
                                total_orders = total_orders + 1
                            WHERE id = ?
                        `).bind(profit, profit, profit, order.user_id).run();

                        await logOrderEvent(env, {
                            orderId: tradeNo,
                            userId: order.user_id,
                            outTradeNo: order.out_trade_no,
                            action: 'paid',
                            fromStatus: 0,
                            toStatus: 1,
                            amount: order.amount,
                            detail: { source: 'status_poll', third_party_trade_no: orderStatus.thirdPartyTradeNo || '' },
                        });

                        return c.json({
                            code: 1,
                            status: 1,
                            msg: '已支付'
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
    const key = c.req.query('key');
    const sign = c.req.query('sign');
    // sign_type 不再从客户端读取，统一由服务端密钥记录决定
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!tradeNo && !outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!sign && !key) return c.json({ code: -1, msg: '缺少验证参数' });
    
    try {
        // 查询商户
        const user = await env.DB.prepare(
            'SELECT id FROM users WHERE id = ? AND role = ?'
        ).bind(pid, 'merchant').first();
        
        if (!user) {
            return c.json({ code: -3, msg: '商户不存在' });
        }
        
        // 查询商户的 API 密钥
        const apiKeyRecord = await env.DB.prepare(
            'SELECT api_key, api_key_type FROM api_keys WHERE user_id = ? AND status = 1'
        ).bind(pid).first();
        
        if (!apiKeyRecord) {
            return c.json({ code: -3, msg: '商户未配置 API 密钥' });
        }
        
        // 验证签名或密钥
        if (sign) {
            const signParams: Record<string, string> = { pid };
            if (tradeNo) signParams.trade_no = tradeNo;
            if (outTradeNo) signParams.out_trade_no = outTradeNo;
            
            const signType = resolveServerSignType(apiKeyRecord as { api_key_type?: string | null } | null);
            const isValid = await verifySignAsync(signParams, (apiKeyRecord as any).api_key, sign, signType);
            if (!isValid) {
                return c.json({ code: -2, msg: '签名验证失败' });
            }
        } else if (key) {
            if (key !== (apiKeyRecord as any).api_key) {
                return c.json({ code: -3, msg: '密钥错误' });
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
        const paymentType = await env.DB.prepare(
            'SELECT display_name FROM payment_types WHERE name = ?'
        ).bind(order.payment_type).first();
        
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
    const key = c.req.query('key');
    const limit = parseInt(c.req.query('limit') || '10');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!key) return c.json({ code: -1, msg: '密钥不能为空' });
    
    try {
        // 验证商户
        const user = await env.DB.prepare(
            'SELECT id FROM users WHERE id = ? AND role = ?'
        ).bind(pid, 'merchant').first();
        
        if (!user) {
            return c.json({ code: -3, msg: '商户不存在' });
        }
        
        // 验证密钥
        const apiKeyRecord = await env.DB.prepare(
            'SELECT id FROM api_keys WHERE user_id = ? AND api_key = ? AND status = 1'
        ).bind(pid, key).first();
        
        if (!apiKeyRecord) {
            return c.json({ code: -3, msg: '商户不存在或密钥错误' });
        }
        
        // 构建查询
        let query = 'SELECT o.*, pt.display_name as type_name FROM orders o LEFT JOIN payment_types pt ON o.payment_type = pt.name WHERE o.user_id = ?';
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
 * 申请退款
 * POST /api/pay/refund
 */
payRouter.post('/refund', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    const requestMeta = getRequestLogMeta(c.req.raw);
    
    const pid = body.pid as string;
    const tradeNo = body.trade_no as string;
    const outTradeNo = body.out_trade_no as string;
    const amount = body.money as string;
    const key = body.key as string;
    const sign = body.sign as string;
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!tradeNo && !outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!amount) return c.json({ code: -1, msg: '退款金额不能为空' });
    if (!key && !sign) return c.json({ code: -1, msg: '缺少验证参数' });
    
    const refundAmount = parseFloat(amount);
    if (isNaN(refundAmount) || refundAmount <= 0) {
        return c.json({ code: -1, msg: '退款金额不合法' });
    }
    
    try {
        // 验证商户
        const user = await env.DB.prepare(
            'SELECT id FROM users WHERE id = ? AND role = ?'
        ).bind(pid, 'merchant').first();
        
        if (!user) {
            return c.json({ code: -3, msg: '商户不存在' });
        }
        
        // 查询商户的 API 密钥
        const apiKeyRecord = await env.DB.prepare(
            'SELECT api_key, api_key_type FROM api_keys WHERE user_id = ? AND status = 1'
        ).bind(pid).first();
        
        if (!apiKeyRecord) {
            return c.json({ code: -3, msg: '商户未配置 API 密钥' });
        }
        
        // 验证密钥或签名
        if (sign) {
            const signParams: Record<string, string> = { pid, money: amount };
            if (tradeNo) signParams.trade_no = tradeNo;
            if (outTradeNo) signParams.out_trade_no = outTradeNo;
            const signType = resolveServerSignType(apiKeyRecord as { api_key_type?: string | null } | null);
            const isValid = await verifySignAsync(signParams, (apiKeyRecord as any).api_key, sign, signType);
            if (!isValid) return c.json({ code: -2, msg: '签名验证失败' });
        } else if (key) {
            if (key !== (apiKeyRecord as any).api_key) return c.json({ code: -3, msg: '密钥错误' });
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
        
        if (order.status !== 1) {
            return c.json({ code: -1, msg: '订单状态不允许退款' });
        }
        
        const remainingRefundAmount = order.amount - (order.refund_amount || 0);
        if (refundAmount > remainingRefundAmount) {
            return c.json({ code: -1, msg: '退款金额超过可退金额' });
        }
        
        // 创建退款记录
        const refundNo = generateUUIDv7();
        const now = new Date().toISOString();
        
        await env.DB.prepare(`
            INSERT INTO refunds (id, refund_no, order_id, user_id, amount, status, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)
        `).bind(refundNo, refundNo, order.id, pid, refundAmount, now).run();
        
        // 更新订单退款金额
        await env.DB.prepare(`
            UPDATE orders SET refund_amount = refund_amount + ? WHERE id = ?
        `).bind(refundAmount, order.id).run();
        
        // 如果全额退款，更新订单状态
        const isFullRefund = refundAmount >= remainingRefundAmount;
        if (isFullRefund) {
            await env.DB.prepare(
                'UPDATE orders SET status = 2 WHERE id = ?'
            ).bind(order.id).run();
        }

        await logOrderEvent(env, {
            orderId: order.id,
            userId: pid,
            outTradeNo: order.out_trade_no,
            action: 'refund_requested',
            fromStatus: 1,
            toStatus: isFullRefund ? 2 : 1,
            amount: refundAmount,
            detail: { refund_no: refundNo, remaining_before_refund: remainingRefundAmount },
            ...requestMeta,
        });

        await logPaymentEvent(env, {
            orderId: order.id,
            userId: pid,
            channelId: order.channel_id,
            plugin: order.plugin,
            direction: 'internal',
            action: 'refund',
            status: 'accepted',
            amount: refundAmount,
            requestData: { refund_no: refundNo, reason: body.reason || '' },
        });
        
        // TODO: 调用支付渠道退款接口
        
        return c.json({
            code: 0,
            msg: `退款成功！退款金额¥${refundAmount.toFixed(2)}`,
            refund_no: refundNo,
            trade_no: order.id,
            money: refundAmount
        });
    } catch (error) {
        console.error('Refund error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询退款记录
 * GET /api/pay/refund/query
 */
payRouter.get('/refund/query', async (c) => {
    const env = c.env;
    const pid = c.req.query('pid');
    const refundNo = c.req.query('refund_no');
    const outTradeNo = c.req.query('out_trade_no');
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!refundNo && !outTradeNo) return c.json({ code: -1, msg: '退款单号不能为空' });
    
    try {
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
            code: 0,
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
    const key = body.key as string;
    const sign = body.sign as string;
    
    if (!pid) return c.json({ code: -1, msg: '商户ID不能为空' });
    if (!tradeNo && !outTradeNo) return c.json({ code: -1, msg: '订单号不能为空' });
    if (!key && !sign) return c.json({ code: -1, msg: '缺少验证参数' });
    
    try {
        // 验证商户
        const user = await env.DB.prepare(
            'SELECT id FROM users WHERE id = ? AND role = ?'
        ).bind(pid, 'merchant').first();
        
        if (!user) {
            return c.json({ code: -3, msg: '商户不存在' });
        }
        
        // 查询商户的 API 密钥
        const apiKeyRecord = await env.DB.prepare(
            'SELECT api_key, api_key_type FROM api_keys WHERE user_id = ? AND status = 1'
        ).bind(pid).first();
        
        if (!apiKeyRecord) {
            return c.json({ code: -3, msg: '商户未配置 API 密钥' });
        }
        
        // 验证密钥或签名
        if (sign) {
            const signParams: Record<string, string> = { pid };
            if (tradeNo) signParams.trade_no = tradeNo;
            if (outTradeNo) signParams.out_trade_no = outTradeNo;
            const signType = resolveServerSignType(apiKeyRecord as { api_key_type?: string | null } | null);
            const isValid = await verifySignAsync(signParams, (apiKeyRecord as any).api_key, sign, signType);
            if (!isValid) return c.json({ code: -2, msg: '签名验证失败' });
        } else if (key) {
            if (key !== (apiKeyRecord as any).api_key) return c.json({ code: -3, msg: '密钥错误' });
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
        
        return c.json({
            code: 0,
            msg: '订单关闭成功'
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
