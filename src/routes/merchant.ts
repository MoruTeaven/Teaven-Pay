/**
 * 商户路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { authMiddleware, merchantMiddleware, signJWT } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { generateUUIDv7 } from '../utils/uuid';

export const merchantRouter = new Hono<{ Bindings: Env }>();

// 登录接口（无需认证）
merchantRouter.post('/login', async (c) => {
    try {
        const body = await c.req.parseBody();
        const username = (body.username as string || '').trim();
        const password = body.password as string || '';

        if (!username || !password) {
            return c.json({ code: -1, msg: '用户名和密码不能为空' });
        }

        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE (username = ? OR email = ?) AND role = ?'
        ).bind(username, username, 'merchant').first();

        if (!user) {
            return c.json({ code: -1, msg: '用户名或密码错误' });
        }

        const valid = await verifyPassword(password, (user as any).password_hash, (user as any).salt);
        if (!valid) {
            return c.json({ code: -1, msg: '用户名或密码错误' });
        }

        if ((user as any).status !== 1) {
            return c.json({ code: -2, msg: '账号已被禁用' });
        }

        const secret = c.env.JWT_SECRET || 'default-secret-change-me';
        const token = await signJWT(
            { id: (user as any).id, username: (user as any).username, role: 'merchant' },
            secret,
            86400
        );

        const now = new Date().toISOString();
        const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
        await c.env.DB.prepare(
            "UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?"
        ).bind(now, ip, (user as any).id).run();

        return c.json({
            code: 0,
            msg: '登录成功',
            data: {
                token,
                user: {
                    id: (user as any).id,
                    username: (user as any).username,
                    email: (user as any).email,
                    role: 'merchant',
                    status: (user as any).status,
                }
            }
        });
    } catch (error) {
        console.error('Merchant login error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

// 以下路由需要认证和商户权限
merchantRouter.use('*', authMiddleware);
merchantRouter.use('*', merchantMiddleware);

/**
 * 退出登录
 * POST /api/merchant/logout
 */
merchantRouter.post('/logout', async (c) => {
    return c.json({ code: 0, msg: '退出成功' });
});

/**
 * 获取当前登录用户资料
 * GET /api/merchant/profile
 */
merchantRouter.get('/profile', async (c) => {
    const payload = c.get('user') as any;

    try {
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user) {
            return c.json({ code: -2, msg: '用户不存在' }, 401);
        }

        // 获取用户的 API 密钥列表
        const apiKeysResult = await c.env.DB.prepare(
            'SELECT id, name, api_key_type, status, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(payload.id).all();

        const u = user as any;

        return c.json({
            code: 0,
            msg: 'success',
            data: {
                id: u.id,
                username: u.username,
                email: u.email,
                status: u.status,
                balance: u.balance,
                frozen_balance: u.frozen_balance,
                api_keys: apiKeysResult.results || [],
                notify_url: u.notify_url,
                return_url: u.return_url,
                contact_qq: u.contact_qq,
                contact_wechat: u.contact_wechat,
                contact_phone: u.contact_phone,
                settle_type: u.settle_type,
                settle_account: u.settle_account,
                settle_name: u.settle_name,
                deposit: u.deposit,
                today_income: u.today_income,
                total_income: u.total_income,
                today_orders: u.today_orders,
                total_orders: u.total_orders,
                last_login_at: u.last_login_at,
                last_login_ip: u.last_login_ip,
                created_at: u.created_at,
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 更新用户资料
 * PUT /api/merchant/profile
 */
merchantRouter.put('/profile', async (c) => {
    const payload = c.get('user') as any;
    const body = await c.req.parseBody();

    const allowedFields: Record<string, string> = {};
    if (body.email !== undefined) allowedFields.email = (body.email as string).trim();
    if (body.contact_qq !== undefined) allowedFields.contact_qq = (body.contact_qq as string).trim();
    if (body.contact_wechat !== undefined) allowedFields.contact_wechat = (body.contact_wechat as string).trim();
    if (body.contact_phone !== undefined) allowedFields.contact_phone = (body.contact_phone as string).trim();
    if (body.settle_type !== undefined) allowedFields.settle_type = (body.settle_type as string).trim();
    if (body.settle_account !== undefined) allowedFields.settle_account = (body.settle_account as string).trim();
    if (body.settle_name !== undefined) allowedFields.settle_name = (body.settle_name as string).trim();

    if (Object.keys(allowedFields).length === 0) {
        return c.json({ code: -1, msg: '没有需要更新的字段' });
    }

    try {
        if (allowedFields.email !== undefined) {
            const existing = await c.env.DB.prepare(
                'SELECT id FROM users WHERE email = ? AND id != ?'
            ).bind(allowedFields.email, payload.id).first();
            if (existing) {
                return c.json({ code: -1, msg: '该邮箱已被使用' });
            }
        }

        const sets = Object.keys(allowedFields).map(k => `${k} = ?`).join(', ');
        const values = Object.values(allowedFields);
        await c.env.DB.prepare(
            `UPDATE users SET ${sets}, updated_at = datetime('now') WHERE id = ?`
        ).bind(...values, payload.id).run();

        return c.json({ code: 0, msg: '更新成功' });
    } catch (error) {
        console.error('Update profile error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 获取仪表盘数据
 * GET /api/merchant/dashboard
 */
merchantRouter.get('/dashboard', async (c) => {
    const payload = c.get('user') as any;

    try {
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user) {
            return c.json({ code: -2, msg: '用户不存在' }, 401);
        }

        const u = user as any;
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        const todayStats = await c.env.DB.prepare(`
            SELECT COUNT(*) as order_count,
                   SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as income
            FROM orders WHERE user_id = ? AND DATE(created_at) = ?
        `).bind(u.id, today).first();

        const yesterdayStats = await c.env.DB.prepare(`
            SELECT COUNT(*) as order_count,
                   SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as income
            FROM orders WHERE user_id = ? AND DATE(created_at) = ?
        `).bind(u.id, yesterday).first();

        const trendRows = await c.env.DB.prepare(`
            SELECT DATE(created_at) as date,
                   COUNT(*) as orders,
                   SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as amount
            FROM orders
            WHERE user_id = ? AND created_at >= datetime('now', '-6 days', 'start of day')
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) ASC
        `).bind(u.id).all();

        const trendMap = new Map<string, { orders: number; amount: number }>();
        for (const row of trendRows.results) {
            const r = row as any;
            trendMap.set(r.date, { orders: r.orders || 0, amount: r.amount || 0 });
        }
        const trend: { date: string; orders: number; amount: number }[] = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const val = trendMap.get(dateStr);
            trend.push({ date: dateStr, orders: val ? val.orders : 0, amount: val ? val.amount : 0 });
        }

        const recentOrders = await c.env.DB.prepare(`
            SELECT id, out_trade_no, payment_type, amount, status, name, created_at, paid_at
            FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
        `).bind(u.id).all();

        const recentSettlements = await c.env.DB.prepare(`
            SELECT id, amount, status, created_at, processed_at
            FROM settlements WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
        `).bind(u.id).all();

        return c.json({
            code: 0,
            msg: 'success',
            data: {
                balance: u.balance,
                frozen_balance: u.frozen_balance,
                today_orders: (todayStats as any)?.order_count || 0,
                today_income: (todayStats as any)?.income || 0,
                yesterday_orders: (yesterdayStats as any)?.order_count || 0,
                yesterday_income: (yesterdayStats as any)?.income || 0,
                total_orders: u.total_orders,
                total_income: u.total_income,
                trend,
                recent_orders: recentOrders.results,
                recent_settlements: recentSettlements.results,
            }
        });
    } catch (error) {
        console.error('Get dashboard error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询商户信息（易支付兼容）
 * GET /api/merchant/query
 */
merchantRouter.get('/query', async (c) => {
    const user = c.get('user') as any;

    try {
        const today = new Date().toISOString().split('T')[0];
        const todayStats = await c.env.DB.prepare(`
            SELECT COUNT(*) as order_count,
                   SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as income
            FROM orders WHERE user_id = ? AND DATE(created_at) = ?
        `).bind(user.id, today).first();

        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const yesterdayStats = await c.env.DB.prepare(`
            SELECT COUNT(*) as order_count,
                   SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as income
            FROM orders WHERE user_id = ? AND DATE(created_at) = ?
        `).bind(user.id, yesterday).first();

        return c.json({
            code: 1,
            pid: user.id,
            username: user.username,
            email: user.email,
            balance: user.balance,
            frozen_balance: user.frozen_balance,
            status: user.status,
            contact_qq: user.contact_qq,
            contact_wechat: user.contact_wechat,
            settle_type: user.settle_type,
            settle_account: user.settle_account,
            today_orders: todayStats?.order_count || 0,
            today_income: todayStats?.income || 0,
            yesterday_orders: yesterdayStats?.order_count || 0,
            yesterday_income: yesterdayStats?.income || 0,
            total_orders: user.total_orders,
            total_income: user.total_income
        });
    } catch (error) {
        console.error('Query merchant error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 用户中心订单列表
 * GET /api/merchant/orders
 */
merchantRouter.get('/orders', async (c) => {
    const payload = c.get('user') as any;
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const paymentType = c.req.query('payment_type');
    const keyword = c.req.query('keyword');

    try {
        let query = 'SELECT o.*, pt.display_name as type_name FROM orders o LEFT JOIN payment_types pt ON o.payment_type = pt.name WHERE o.user_id = ?';
        const params: any[] = [payload.id];

        if (status !== undefined && status !== '') {
            query += ' AND o.status = ?';
            params.push(parseInt(status));
        }
        if (paymentType) {
            query += ' AND o.payment_type = ?';
            params.push(paymentType);
        }
        if (keyword) {
            query += ' AND (o.id LIKE ? OR o.out_trade_no LIKE ? OR o.name LIKE ?)';
            const like = `%${keyword}%`;
            params.push(like, like, like);
        }

        query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
        params.push(Math.min(limit, 100), offset);

        const orders = await c.env.DB.prepare(query).bind(...params).all();

        let countQuery = 'SELECT COUNT(*) as total FROM orders WHERE user_id = ?';
        const countParams: any[] = [payload.id];
        if (status !== undefined && status !== '') {
            countQuery += ' AND status = ?';
            countParams.push(parseInt(status));
        }
        if (paymentType) {
            countQuery += ' AND payment_type = ?';
            countParams.push(paymentType);
        }
        if (keyword) {
            countQuery += ' AND (id LIKE ? OR out_trade_no LIKE ? OR name LIKE ?)';
            const like = `%${keyword}%`;
            countParams.push(like, like, like);
        }
        const count = await c.env.DB.prepare(countQuery).bind(...countParams).first();

        return c.json({
            code: 0,
            msg: 'success',
            data: {
                total: (count as any)?.total || 0,
                list: orders.results.map((o: any) => ({
                    id: o.id,
                    out_trade_no: o.out_trade_no,
                    payment_type: o.payment_type,
                    type_name: o.type_name || o.payment_type,
                    amount: o.amount,
                    actual_amount: o.actual_amount,
                    fee: o.fee,
                    status: o.status,
                    name: o.name,
                    buyer: o.buyer,
                    notify_status: o.notify_status,
                    created_at: o.created_at,
                    paid_at: o.paid_at,
                    closed_at: o.closed_at,
                }))
            }
        });
    } catch (error) {
        console.error('Merchant orders error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 用户中心订单详情
 * GET /api/merchant/orders/:id
 */
merchantRouter.get('/orders/:id', async (c) => {
    const payload = c.get('user') as any;
    const orderId = c.req.param('id');

    try {
        const order = await c.env.DB.prepare(
            'SELECT o.*, pt.display_name as type_name FROM orders o LEFT JOIN payment_types pt ON o.payment_type = pt.name WHERE o.id = ? AND o.user_id = ?'
        ).bind(orderId, payload.id).first();

        if (!order) {
            return c.json({ code: -1, msg: '订单不存在' });
        }

        return c.json({ code: 0, msg: 'success', data: order });
    } catch (error) {
        console.error('Merchant order detail error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 关闭订单
 * POST /api/merchant/orders/:id/close
 */
merchantRouter.post('/orders/:id/close', async (c) => {
    const payload = c.get('user') as any;
    const orderId = c.req.param('id');

    try {
        const order = await c.env.DB.prepare(
            'SELECT * FROM orders WHERE id = ? AND user_id = ?'
        ).bind(orderId, payload.id).first();

        if (!order) {
            return c.json({ code: -1, msg: '订单不存在' });
        }

        if ((order as any).status !== 0) {
            return c.json({ code: -1, msg: '该订单无法关闭' });
        }

        await c.env.DB.prepare(
            "UPDATE orders SET status = 3, closed_at = datetime('now') WHERE id = ?"
        ).bind(orderId).run();

        return c.json({ code: 0, msg: '订单已关闭' });
    } catch (error) {
        console.error('Close order error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询退款记录
 * GET /api/merchant/refunds
 */
merchantRouter.get('/refunds', async (c) => {
    const payload = c.get('user') as any;
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const keyword = c.req.query('keyword');

    try {
        let query = `SELECT r.*, o.out_trade_no, o.name as order_name, o.payment_type
                     FROM refunds r LEFT JOIN orders o ON r.order_id = o.id
                     WHERE r.user_id = ?`;
        const params: any[] = [payload.id];

        if (status !== undefined && status !== '') {
            query += ' AND r.status = ?';
            params.push(parseInt(status));
        }
        if (keyword) {
            query += ' AND (r.refund_no LIKE ? OR r.order_id LIKE ? OR o.out_trade_no LIKE ?)';
            const like = `%${keyword}%`;
            params.push(like, like, like);
        }

        query += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
        params.push(Math.min(limit, 100), offset);

        const refunds = await c.env.DB.prepare(query).bind(...params).all();

        let countQuery = 'SELECT COUNT(*) as total FROM refunds WHERE user_id = ?';
        const countParams: any[] = [payload.id];
        if (status !== undefined && status !== '') {
            countQuery += ' AND status = ?';
            countParams.push(parseInt(status));
        }
        const count = await c.env.DB.prepare(countQuery).bind(...countParams).first();

        return c.json({
            code: 0,
            msg: 'success',
            data: {
                total: (count as any)?.total || 0,
                list: refunds.results
            }
        });
    } catch (error) {
        console.error('Merchant refunds error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 查询结算记录
 * GET /api/merchant/settle/list
 */
merchantRouter.get('/settle/list', async (c) => {
    const payload = c.get('user') as any;
    const limit = parseInt(c.req.query('limit') || '10');
    const offset = parseInt(c.req.query('offset') || '0');

    try {
        const settlements = await c.env.DB.prepare(`
            SELECT * FROM settlements WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
        `).bind(payload.id, Math.min(limit, 50), offset).all();

        const count = await c.env.DB.prepare(
            'SELECT COUNT(*) as total FROM settlements WHERE user_id = ?'
        ).bind(payload.id).first();

        return c.json({
            code: 1,
            msg: '查询结算记录成功！',
            count: count?.total || 0,
            data: settlements.results
        });
    } catch (error) {
        console.error('Query settlements error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 申请结算
 * POST /api/merchant/settle/apply
 */
merchantRouter.post('/settle/apply', async (c) => {
    const payload = c.get('user') as any;
    const body = await c.req.parseBody();

    const amount = parseFloat(body.amount as string);
    const settleAccount = body.settle_account as string;
    const settleName = body.settle_name as string;
    const bankName = body.bank_name as string;

    if (!amount || amount <= 0) {
        return c.json({ code: -1, msg: '结算金额不合法' });
    }

    try {
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user || (user as any).status !== 1) {
            return c.json({ code: -1, msg: '账号状态异常' });
        }

        const minSettleStr = await c.env.DB.prepare(
            "SELECT value FROM system_config WHERE key = 'min_settle_amount'"
        ).first();
        const minSettle = parseFloat(minSettleStr?.value || '100');

        if (amount < minSettle) {
            return c.json({ code: -1, msg: `最低结算金额为 ${minSettle} 元` });
        }

        if (amount > (user as any).balance) {
            return c.json({ code: -1, msg: '余额不足' });
        }

        const settleId = generateUUIDv7();
        const now = new Date().toISOString();

        await c.env.DB.prepare(`
            INSERT INTO settlements (
                id, user_id, amount, settle_type, settle_account,
                settle_name, bank_name, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).bind(
            settleId, payload.id, amount, (user as any).settle_type,
            settleAccount || (user as any).settle_account,
            settleName || (user as any).settle_name,
            bankName, now
        ).run();

        await c.env.DB.prepare(`
            UPDATE users SET balance = balance - ?, frozen_balance = frozen_balance + ? WHERE id = ?
        `).bind(amount, amount, payload.id).run();

        await c.env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, detail, ip, created_at)
            VALUES (?, 'settle_apply', ?, ?, ?)
        `).bind(
            payload.id,
            JSON.stringify({ amount, settle_id: settleId }),
            c.req.header('CF-Connecting-IP') || '',
            now
        ).run();

        return c.json({ code: 0, msg: '结算申请已提交', data: { settle_id: settleId } });
    } catch (error) {
        console.error('Apply settle error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 域名白名单列表
 * GET /api/merchant/domains
 */
merchantRouter.get('/domains', async (c) => {
    const payload = c.get('user') as any;

    try {
        const rows = await c.env.DB.prepare(
            'SELECT * FROM domain_whitelist WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(payload.id).all();

        return c.json({ code: 0, msg: 'success', data: rows.results });
    } catch (error) {
        console.error('Get domains error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 新增域名白名单
 * POST /api/merchant/domains
 */
merchantRouter.post('/domains', async (c) => {
    const payload = c.get('user') as any;
    const body = await c.req.parseBody();
    const domain = (body.domain as string || '').trim().toLowerCase();

    if (!domain) {
        return c.json({ code: -1, msg: '域名不能为空' });
    }

    if (domain.includes('://') || domain.includes('/')) {
        return c.json({ code: -1, msg: '域名不能包含协议或路径' });
    }

    try {
        const existing = await c.env.DB.prepare(
            'SELECT id FROM domain_whitelist WHERE user_id = ? AND domain = ?'
        ).bind(payload.id, domain).first();

        if (existing) {
            return c.json({ code: -1, msg: '该域名已存在' });
        }

        await c.env.DB.prepare(
            'INSERT INTO domain_whitelist (user_id, domain, status, created_at) VALUES (?, ?, 1, datetime(\'now\'))'
        ).bind(payload.id, domain).run();

        return c.json({ code: 0, msg: '添加成功' });
    } catch (error) {
        console.error('Add domain error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 删除域名白名单
 * DELETE /api/merchant/domains/:id
 */
merchantRouter.delete('/domains/:id', async (c) => {
    const payload = c.get('user') as any;
    const domainId = c.req.param('id');

    try {
        const domain = await c.env.DB.prepare(
            'SELECT * FROM domain_whitelist WHERE id = ? AND user_id = ?'
        ).bind(domainId, payload.id).first();

        if (!domain) {
            return c.json({ code: -1, msg: '域名不存在' });
        }

        await c.env.DB.prepare('DELETE FROM domain_whitelist WHERE id = ?').bind(domainId).run();

        return c.json({ code: 0, msg: '删除成功' });
    } catch (error) {
        console.error('Delete domain error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 更新回调配置
 * PUT /api/merchant/developer/urls
 */
merchantRouter.put('/developer/urls', async (c) => {
    const payload = c.get('user') as any;
    const body = await c.req.parseBody();

    const notifyUrl = body.notify_url as string;
    const returnUrl = body.return_url as string;

    try {
        await c.env.DB.prepare(
            "UPDATE users SET notify_url = ?, return_url = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(notifyUrl || null, returnUrl || null, payload.id).run();

        return c.json({ code: 0, msg: '更新成功' });
    } catch (error) {
        console.error('Update developer urls error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 修改密码
 * POST /api/merchant/password
 */
merchantRouter.post('/password', async (c) => {
    const payload = c.get('user') as any;
    const body = await c.req.parseBody();

    const oldPassword = body.old_password as string;
    const newPassword = body.new_password as string;

    if (!oldPassword || !newPassword) {
        return c.json({ code: -1, msg: '请输入旧密码和新密码' });
    }

    if (newPassword.length < 6) {
        return c.json({ code: -1, msg: '新密码长度不能少于6位' });
    }

    try {
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user) {
            return c.json({ code: -2, msg: '用户不存在' }, 401);
        }

        const isValid = await verifyPassword(oldPassword, (user as any).password_hash, (user as any).salt);
        if (!isValid) {
            return c.json({ code: -1, msg: '旧密码错误' });
        }

        const { hash, salt } = await hashPassword(newPassword);

        await c.env.DB.prepare(`
            UPDATE users SET password_hash = ?, salt = ?, updated_at = datetime('now') WHERE id = ?
        `).bind(hash, salt, payload.id).run();

        const now = new Date().toISOString();
        await c.env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, detail, ip, created_at)
            VALUES (?, 'change_password', '{}', ?, ?)
        `).bind(payload.id, c.req.header('CF-Connecting-IP') || '', now).run();

        return c.json({ code: 0, msg: '密码修改成功' });
    } catch (error) {
        console.error('Change password error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
