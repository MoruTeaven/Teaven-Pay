/**
 * 商户路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { authMiddleware, merchantMiddleware } from '../middleware/auth';
import { generateUUIDv7 } from '../utils/uuid';

export const merchantRouter = new Hono<{ Bindings: Env }>();

// 应用认证中间件
merchantRouter.use('*', authMiddleware);
merchantRouter.use('*', merchantMiddleware);

/**
 * 查询商户信息
 * GET /api/merchant/query
 */
merchantRouter.get('/query', async (c) => {
    const user = c.get('user') as any;
    
    try {
        // 获取今日统计
        const today = new Date().toISOString().split('T')[0];
        const todayStats = await c.env.DB.prepare(`
            SELECT 
                COUNT(*) as order_count,
                SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as income
            FROM orders 
            WHERE user_id = ? AND DATE(created_at) = ?
        `).bind(user.id, today).first();
        
        // 获取昨日统计
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const yesterdayStats = await c.env.DB.prepare(`
            SELECT 
                COUNT(*) as order_count,
                SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as income
            FROM orders 
            WHERE user_id = ? AND DATE(created_at) = ?
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
 * 查询结算记录
 * GET /api/merchant/settle/list
 */
merchantRouter.get('/settle/list', async (c) => {
    const user = c.get('user') as any;
    const limit = parseInt(c.req.query('limit') || '10');
    const offset = parseInt(c.req.query('offset') || '0');
    
    try {
        const settlements = await c.env.DB.prepare(`
            SELECT * FROM settlements 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `).bind(user.id, Math.min(limit, 50), offset).all();
        
        const count = await c.env.DB.prepare(
            'SELECT COUNT(*) as total FROM settlements WHERE user_id = ?'
        ).bind(user.id).first();
        
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
    const user = c.get('user') as any;
    const body = await c.req.parseBody();
    
    const amount = parseFloat(body.amount as string);
    const settleAccount = body.settle_account as string;
    const settleName = body.settle_name as string;
    const bankName = body.bank_name as string;
    
    if (!amount || amount <= 0) {
        return c.json({ code: -1, msg: '结算金额不合法' });
    }
    
    // 检查最低结算金额
    const minSettleStr = await c.env.DB.prepare(
        "SELECT value FROM system_config WHERE key = 'min_settle_amount'"
    ).first();
    const minSettle = parseFloat(minSettleStr?.value || '100');
    
    if (amount < minSettle) {
        return c.json({ code: -1, msg: `最低结算金额为 ${minSettle} 元` });
    }
    
    if (amount > user.balance) {
        return c.json({ code: -1, msg: '余额不足' });
    }
    
    try {
        const settleId = generateUUIDv7();
        const now = new Date().toISOString();
        
        // 创建结算记录
        await c.env.DB.prepare(`
            INSERT INTO settlements (
                id, user_id, amount, settle_type, settle_account, 
                settle_name, bank_name, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).bind(
            settleId, user.id, amount, user.settle_type,
            settleAccount || user.settle_account,
            settleName || user.settle_name,
            bankName, now
        ).run();
        
        // 冻结余额
        await c.env.DB.prepare(`
            UPDATE users SET 
                balance = balance - ?,
                frozen_balance = frozen_balance + ?
            WHERE id = ?
        `).bind(amount, amount, user.id).run();
        
        return c.json({
            code: 0,
            msg: '结算申请已提交',
            settle_id: settleId
        });
    } catch (error) {
        console.error('Apply settle error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 修改密码
 * POST /api/merchant/password
 */
merchantRouter.post('/password', async (c) => {
    const user = c.get('user') as any;
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
        // 验证旧密码
        const { hashPassword, verifyPassword } = await import('../utils/crypto');
        const isValid = await verifyPassword(oldPassword, user.password_hash, user.salt);
        
        if (!isValid) {
            return c.json({ code: -1, msg: '旧密码错误' });
        }
        
        // 生成新密码哈希
        const { hash, salt } = await hashPassword(newPassword);
        
        // 更新密码
        await c.env.DB.prepare(`
            UPDATE users SET password_hash = ?, salt = ?, updated_at = datetime('now')
            WHERE id = ?
        `).bind(hash, salt, user.id).run();
        
        return c.json({
            code: 0,
            msg: '密码修改成功'
        });
    } catch (error) {
        console.error('Change password error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
