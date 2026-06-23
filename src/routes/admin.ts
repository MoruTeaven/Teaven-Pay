/**
 * 管理后台路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { generateUUIDv7 } from '../utils/uuid';
import { hashPassword } from '../utils/crypto';

export const adminRouter = new Hono<{ Bindings: Env }>();

// 应用认证和管理员权限中间件
adminRouter.use('*', authMiddleware);
adminRouter.use('*', adminMiddleware);

/**
 * 获取系统统计
 * GET /api/admin/stats
 */
adminRouter.get('/stats', async (c) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // 今日统计
        const todayStats = await c.env.DB.prepare(`
            SELECT 
                COUNT(*) as total_orders,
                SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as success_orders,
                SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as total_amount,
                SUM(CASE WHEN status = 1 THEN profit ELSE 0 END) as total_profit
            FROM orders 
            WHERE DATE(created_at) = ?
        `).bind(today).first();
        
        // 商户统计
        const merchantStats = await c.env.DB.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) as pending
            FROM users 
            WHERE role = 'merchant'
        `).first();
        
        // 总统计
        const totalStats = await c.env.DB.prepare(`
            SELECT 
                COUNT(*) as total_orders,
                SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as total_amount
            FROM orders
        `).first();
        
        return c.json({
            code: 1,
            data: {
                today: {
                    orders: todayStats?.total_orders || 0,
                    success_orders: todayStats?.success_orders || 0,
                    amount: todayStats?.total_amount || 0,
                    profit: todayStats?.total_profit || 0
                },
                merchants: {
                    total: merchantStats?.total || 0,
                    active: merchantStats?.active || 0,
                    pending: merchantStats?.pending || 0
                },
                total: {
                    orders: totalStats?.total_orders || 0,
                    amount: totalStats?.total_amount || 0
                }
            }
        });
    } catch (error) {
        console.error('Get stats error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 商户列表
 * GET /api/admin/merchants
 */
adminRouter.get('/merchants', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const keyword = c.req.query('keyword');
    
    try {
        let query = 'SELECT * FROM users WHERE role = ?';
        const params: any[] = ['merchant'];
        
        if (status !== undefined) {
            query += ' AND status = ?';
            params.push(parseInt(status));
        }
        
        if (keyword) {
            query += ' AND (username LIKE ? OR email LIKE ? OR id LIKE ?)';
            const likeKeyword = `%${keyword}%`;
            params.push(likeKeyword, likeKeyword, likeKeyword);
        }
        
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(Math.min(limit, 100), offset);
        
        const merchants = await c.env.DB.prepare(query).bind(...params).all();
        
        const countQuery = 'SELECT COUNT(*) as total FROM users WHERE role = ?' + 
            (status !== undefined ? ' AND status = ?' : '') +
            (keyword ? ' AND (username LIKE ? OR email LIKE ? OR id LIKE ?)' : '');
        const countParams = ['merchant'];
        if (status !== undefined) countParams.push(parseInt(status));
        if (keyword) {
            const likeKeyword = `%${keyword}%`;
            countParams.push(likeKeyword, likeKeyword, likeKeyword);
        }
        const count = await c.env.DB.prepare(countQuery).bind(...countParams).first();
        
        return c.json({
            code: 1,
            count: count?.total || 0,
            data: merchants.results
        });
    } catch (error) {
        console.error('Get merchants error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 创建商户
 * POST /api/admin/merchants
 */
adminRouter.post('/merchants', async (c) => {
    const body = await c.req.parseBody();
    
    const username = body.username as string;
    const email = body.email as string;
    const password = body.password as string;
    
    if (!username || !password) {
        return c.json({ code: -1, msg: '用户名和密码不能为空' });
    }
    
    try {
        // 检查用户名是否已存在
        const existing = await c.env.DB.prepare(
            'SELECT id FROM users WHERE username = ?'
        ).bind(username).first();
        
        if (existing) {
            return c.json({ code: -1, msg: '用户名已存在' });
        }
        
        // 创建用户
        const userId = generateUUIDv7();
        const { hash, salt } = await hashPassword(password);
        const apiKey = generateUUIDv7().replace(/-/g, '');
        
        await c.env.DB.prepare(`
            INSERT INTO users (
                id, username, email, password_hash, salt, 
                role, status, api_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'merchant', 1, ?, datetime('now'), datetime('now'))
        `).bind(userId, username, email, hash, salt, apiKey).run();
        
        return c.json({
            code: 0,
            msg: '商户创建成功',
            data: {
                id: userId,
                username,
                api_key: apiKey
            }
        });
    } catch (error) {
        console.error('Create merchant error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 更新商户状态
 * PUT /api/admin/merchants/:id/status
 */
adminRouter.put('/merchants/:id/status', async (c) => {
    const { id } = c.req.param();
    const body = await c.req.parseBody();
    const status = parseInt(body.status as string);
    
    if (![0, 1, 2].includes(status)) {
        return c.json({ code: -1, msg: '无效的状态值' });
    }
    
    try {
        await c.env.DB.prepare(`
            UPDATE users SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND role = 'merchant'
        `).bind(status, id).run();
        
        return c.json({
            code: 0,
            msg: '状态更新成功'
        });
    } catch (error) {
        console.error('Update merchant status error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 订单列表
 * GET /api/admin/orders
 */
adminRouter.get('/orders', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const userId = c.req.query('user_id');
    const paymentType = c.req.query('payment_type');
    
    try {
        let query = `
            SELECT o.*, u.username, pt.display_name as payment_type_name 
            FROM orders o 
            LEFT JOIN users u ON o.user_id = u.id 
            LEFT JOIN payment_types pt ON o.payment_type = pt.name 
            WHERE 1=1
        `;
        const params: any[] = [];
        
        if (status !== undefined) {
            query += ' AND o.status = ?';
            params.push(parseInt(status));
        }
        
        if (userId) {
            query += ' AND o.user_id = ?';
            params.push(userId);
        }
        
        if (paymentType) {
            query += ' AND o.payment_type = ?';
            params.push(paymentType);
        }
        
        query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
        params.push(Math.min(limit, 100), offset);
        
        const orders = await c.env.DB.prepare(query).bind(...params).all();
        
        return c.json({
            code: 1,
            data: orders.results
        });
    } catch (error) {
        console.error('Get orders error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 结算列表
 * GET /api/admin/settlements
 */
adminRouter.get('/settlements', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    
    try {
        let query = `
            SELECT s.*, u.username 
            FROM settlements s 
            LEFT JOIN users u ON s.user_id = u.id 
            WHERE 1=1
        `;
        const params: any[] = [];
        
        if (status !== undefined) {
            query += ' AND s.status = ?';
            params.push(parseInt(status));
        }
        
        query += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
        params.push(Math.min(limit, 100), offset);
        
        const settlements = await c.env.DB.prepare(query).bind(...params).all();
        
        return c.json({
            code: 1,
            data: settlements.results
        });
    } catch (error) {
        console.error('Get settlements error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 处理结算
 * PUT /api/admin/settlements/:id
 */
adminRouter.put('/settlements/:id', async (c) => {
    const { id } = c.req.param();
    const body = await c.req.parseBody();
    const action = body.action as string; // approve / reject
    const reason = body.reason as string;
    
    if (!['approve', 'reject'].includes(action)) {
        return c.json({ code: -1, msg: '无效的操作' });
    }
    
    try {
        const settlement = await c.env.DB.prepare(
            'SELECT * FROM settlements WHERE id = ? AND status = 0'
        ).bind(id).first();
        
        if (!settlement) {
            return c.json({ code: -4, msg: '结算记录不存在或已处理' });
        }
        
        const now = new Date().toISOString();
        
        if (action === 'approve') {
            // 批准结算
            await c.env.DB.prepare(`
                UPDATE settlements SET status = 2, processed_at = ? WHERE id = ?
            `).bind(now, id).run();
            
            // 扣除冻结余额
            await c.env.DB.prepare(`
                UPDATE users SET 
                    frozen_balance = frozen_balance - ?
                WHERE id = ?
            `).bind(settlement.amount, settlement.user_id).run();
        } else {
            // 拒绝结算
            await c.env.DB.prepare(`
                UPDATE settlements SET status = 3, reject_reason = ?, processed_at = ? WHERE id = ?
            `).bind(reason, now, id).run();
            
            // 退回余额
            await c.env.DB.prepare(`
                UPDATE users SET 
                    balance = balance + ?,
                    frozen_balance = frozen_balance - ?
                WHERE id = ?
            `).bind(settlement.amount, settlement.amount, settlement.user_id).run();
        }
        
        return c.json({
            code: 0,
            msg: action === 'approve' ? '结算已批准' : '结算已拒绝'
        });
    } catch (error) {
        console.error('Process settlement error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 系统配置
 * GET /api/admin/config
 */
adminRouter.get('/config', async (c) => {
    try {
        const configs = await c.env.DB.prepare(
            'SELECT * FROM system_config ORDER BY key'
        ).all();
        
        const configMap: Record<string, string> = {};
        for (const row of configs.results) {
            configMap[(row as any).key] = (row as any).value;
        }
        
        return c.json({
            code: 1,
            data: configMap
        });
    } catch (error) {
        console.error('Get config error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 更新系统配置
 * PUT /api/admin/config
 */
adminRouter.put('/config', async (c) => {
    const body = await c.req.parseBody();
    
    try {
        for (const [key, value] of Object.entries(body)) {
            await c.env.DB.prepare(`
                INSERT OR REPLACE INTO system_config (key, value, updated_at)
                VALUES (?, ?, datetime('now'))
            `).bind(key, value).run();
        }
        
        return c.json({
            code: 0,
            msg: '配置更新成功'
        });
    } catch (error) {
        console.error('Update config error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
