/**
 * 支付路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { generateUUIDv7 } from '../utils/uuid';
import { verifySignAsync } from '../utils/crypto';
import { getPlugin } from '../plugins';

export const payRouter = new Hono<{ Bindings: Env }>();

/**
 * 发起支付 - API 模式
 * POST /api/pay/submit
 */
payRouter.post('/submit', async (c) => {
    const body = await c.req.parseBody();
    const env = c.env;
    
    // 获取参数
    const pid = body.pid as string;
    const type = body.type as string;
    const outTradeNo = body.out_trade_no as string;
    const notifyUrl = body.notify_url as string;
    const returnUrl = body.return_url as string;
    const name = body.name as string;
    const money = body.money as string;
    const sign = body.sign as string;
    const requestedSignType = body.sign_type as string;
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
        
        const signType = requestedSignType || (apiKeyRecord as any).api_key_type || 'hmac-sha256';
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
            return c.json({
                code: 1,
                msg: '创建订单成功',
                trade_no: existingOrder.id,
                payurl: `${env.SITE_URL || 'https://pay.example.com'}/cashier/${existingOrder.id}`
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
        
        // 获取支付插件
        const plugin = getPlugin(channel.plugin);
        
        // 调用插件创建支付
        const channelConfig = JSON.parse(channel.config || '{}');
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
                notifyUrl: channelConfig.notifyUrl || '',
                ...channelConfig
            }
        );
        
        if (!payResult.success) {
            return c.json({ code: -1, msg: payResult.message || '创建支付失败' });
        }
        
        return c.json({
            code: 1,
            msg: '创建订单成功',
            trade_no: tradeNo,
            payurl: payResult.payUrl || `${env.SITE_URL || 'https://pay.example.com'}/cashier/${tradeNo}`,
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

        const plugin = getPlugin(channel.plugin);

        const channelConfig = JSON.parse(channel.config || '{}');
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
                notifyUrl: channelConfig.notifyUrl || user.notify_url || '',
                ...channelConfig
            }
        );

        if (!payResult.success) {
            return c.json({ code: -1, msg: payResult.message || '创建支付失败' });
        }

        return c.json({
            code: 1,
            msg: '创建订单成功',
            trade_no: tradeNo,
            payurl: payResult.payUrl || `${env.SITE_URL || ''}/cashier/${tradeNo}`,
            qrcode: payResult.qrcode
        });
    } catch (error) {
        console.error('Cashier payment error:', error);
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
    const requestedSignType = c.req.query('sign_type');
    
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
            
            const signType = requestedSignType || (apiKeyRecord as any).api_key_type || 'hmac-sha256';
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
            const signType = (body.sign_type as string) || (apiKeyRecord as any).api_key_type || 'hmac-sha256';
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
        
        if (refundAmount > order.amount - (order.refund_amount || 0)) {
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
        if (refundAmount >= order.amount - (order.refund_amount || 0)) {
            await env.DB.prepare(
                'UPDATE orders SET status = 2 WHERE id = ?'
            ).bind(order.id).run();
        }
        
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
            const signType = (body.sign_type as string) || (apiKeyRecord as any).api_key_type || 'hmac-sha256';
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
        
        return c.json({
            code: 0,
            msg: '订单关闭成功'
        });
    } catch (error) {
        console.error('Close order error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
