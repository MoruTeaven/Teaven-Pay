/**
 * 管理后台路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { authMiddleware, adminMiddleware, signJWT } from '../middleware/auth';
import { generateUUIDv7 } from '../utils/uuid';
import { hashPassword, verifyPassword } from '../utils/crypto';

export const adminRouter = new Hono<{ Bindings: Env }>();

/**
 * 管理员登录 (无需认证)
 * POST /api/admin/login
 */
adminRouter.post('/login', async (c) => {
    try {
        const body = await c.req.parseBody();
        const username = body.username as string;
        const password = body.password as string;

        if (!username || !password) {
            return c.json({ code: -1, msg: '用户名和密码不能为空' });
        }

        // 查询管理员用户
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE username = ? AND role = ?'
        ).bind(username, 'admin').first();

        if (!user) {
            return c.json({ code: -1, msg: '用户名或密码错误' });
        }

        // 验证密码
        const valid = await verifyPassword(password, (user as any).password_hash, (user as any).salt);
        if (!valid) {
            return c.json({ code: -1, msg: '用户名或密码错误' });
        }

        // 检查状态
        if ((user as any).status !== 1) {
            return c.json({ code: -2, msg: '账号已被禁用' });
        }

        // 签发 JWT
        const secret = c.env.JWT_SECRET || 'default-secret-change-me';
        const token = await signJWT(
            { id: (user as any).id, username: (user as any).username, role: 'admin' },
            secret,
            86400 // 24小时
        );

        return c.json({
            code: 0,
            msg: '登录成功',
            data: {
                token,
                user: {
                    id: (user as any).id,
                    username: (user as any).username,
                    role: 'admin'
                }
            }
        });
    } catch (error) {
        console.error('Admin login error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

// 以下路由需要认证和管理员权限
adminRouter.use('*', authMiddleware);
adminRouter.use('*', adminMiddleware);

/**
 * 获取系统统计
 * GET /api/admin/stats
 * 返回今日/总览统计、近7日交易趋势、支付方式分布、今日每小时订单统计
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

        // 近7日交易趋势 (每日成功订单金额)
        const trendRows = await c.env.DB.prepare(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as orders,
                SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as amount
            FROM orders
            WHERE created_at >= datetime('now', '-6 days', 'start of day')
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) ASC
        `).all();

        const trend: { dates: string[]; amounts: number[]; orders: number[] } = { dates: [], amounts: [], orders: [] };
        // 补全7天空缺，保证图表连续
        const trendMap = new Map<string, { orders: number; amount: number }>();
        for (const row of trendRows.results) {
            const r = row as any;
            trendMap.set(r.date, { orders: r.orders || 0, amount: r.amount || 0 });
        }
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const val = trendMap.get(dateStr);
            trend.dates.push(`${d.getMonth() + 1}月${d.getDate()}日`);
            trend.amounts.push(val ? val.amount : 0);
            trend.orders.push(val ? val.orders : 0);
        }

        // 支付方式分布 (按成功订单金额)
        const paymentRows = await c.env.DB.prepare(`
            SELECT 
                payment_type as name,
                SUM(CASE WHEN status = 1 THEN amount ELSE 0 END) as amount,
                COUNT(CASE WHEN status = 1 THEN 1 END) as count
            FROM orders
            GROUP BY payment_type
        `).all();
        const paymentNames: Record<string, string> = {
            alipay: '支付宝', wxpay: '微信支付', qqpay: 'QQ钱包',
            unionpay: '银联', jdpay: '京东支付'
        };
        const paymentDistribution = paymentRows.results.map((row: any) => ({
            value: Number(row.amount) || 0,
            name: paymentNames[row.name] || row.name,
            count: row.count || 0
        })).filter((item: any) => item.value > 0);

        // 今日每小时订单统计
        const hourlyRows = await c.env.DB.prepare(`
            SELECT 
                CAST(strftime('%H', created_at) AS INTEGER) as hour,
                COUNT(*) as orders
            FROM orders
            WHERE DATE(created_at) = ?
            GROUP BY hour
            ORDER BY hour ASC
        `).bind(today).all();
        const hourlyMap = new Map<number, number>();
        for (const row of hourlyRows.results) {
            hourlyMap.set((row as any).hour, (row as any).orders || 0);
        }
        const hourly: { hours: string[]; orders: number[] } = { hours: [], orders: [] };
        for (let h = 0; h < 24; h += 2) {
            hourly.hours.push(`${String(h).padStart(2, '0')}:00`);
            // 取 h 和 h+1 两小时之和
            hourly.orders.push((hourlyMap.get(h) || 0) + (hourlyMap.get(h + 1) || 0));
        }

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
                },
                trend,
                paymentDistribution,
                hourly
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
        
        // 转换为驼峰命名，避免前端 undefined
        const mapped = merchants.results.map((row: any) => ({
            id: row.id,
            username: row.username,
            email: row.email || '',
            status: row.status,
            balance: row.balance || 0,
            frozenBalance: row.frozen_balance || 0,
            apiKey: row.api_key || '',
            apiKeyType: row.api_key_type || 'md5',
            notifyUrl: row.notify_url || '',
            returnUrl: row.return_url || '',
            settleType: row.settle_type || '',
            settleAccount: row.settle_account || '',
            settleName: row.settle_name || '',
            groupId: row.group_id || '',
            todayIncome: row.today_income || 0,
            totalIncome: row.total_income || 0,
            todayOrders: row.today_orders || 0,
            totalOrders: row.total_orders || 0,
            lastLoginAt: row.last_login_at || '',
            lastLoginIp: row.last_login_ip || '',
            createdAt: row.created_at || '',
            updatedAt: row.updated_at || ''
        }));
        
        return c.json({
            code: 1,
            count: count?.total || 0,
            data: mapped
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
        
        // 转换为驼峰命名
        const mapped = orders.results.map((row: any) => ({
            id: row.id,
            tradeNo: row.id, // 平台订单号即 id
            outTradeNo: row.out_trade_no || '',
            userId: row.user_id,
            merchant: row.username || '-',
            paymentType: row.payment_type || '',
            paymentTypeName: row.payment_type_name || '',
            channelId: row.channel_id || '',
            amount: row.amount || 0,
            actualAmount: row.actual_amount || 0,
            fee: row.fee || 0,
            profit: row.profit || 0,
            status: row.status,
            name: row.name || '',
            buyerIp: row.buyer_ip || '',
            notifyStatus: row.notify_status || 0,
            notifyCount: row.notify_count || 0,
            domain: row.domain || '',
            apiTradeNo: row.api_trade_no || '',
            createdAt: row.created_at || '',
            paidAt: row.paid_at || '',
            closedAt: row.closed_at || ''
        }));
        
        return c.json({
            code: 1,
            data: mapped
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
        
        // 转换为驼峰命名
        const mapped = settlements.results.map((row: any) => ({
            id: row.id,
            userId: row.user_id,
            merchant: row.username || '-',
            amount: row.amount || 0,
            fee: row.fee || 0,
            actualAmount: row.actual_amount || 0,
            settleType: row.settle_type || '',
            settleAccount: row.settle_account || '',
            settleName: row.settle_name || '',
            bankName: row.bank_name || '',
            bankBranch: row.bank_branch || '',
            bankInfo: [row.settle_type, row.settle_name, row.settle_account, row.bank_name].filter(Boolean).join(' / '),
            status: row.status,
            rejectReason: row.reject_reason || '',
            processedAt: row.processed_at || '',
            createdAt: row.created_at || ''
        }));
        
        return c.json({
            code: 1,
            data: mapped
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

/**
 * 支付方式列表
 * GET /api/admin/payment-types
 */
adminRouter.get('/payment-types', async (c) => {
    try {
        const result = await c.env.DB.prepare(
            'SELECT * FROM payment_types ORDER BY sort_order ASC'
        ).all();

        const iconMap: Record<string, string> = {
            alipay: 'ri-alipay-line',
            wxpay: 'ri-wechat-pay-line',
            qqpay: 'ri-qq-line',
            unionpay: 'ri-bank-card-line',
            jdpay: 'ri-shopping-bag-line'
        };

        const mapped = result.results.map((row: any) => ({
            id: row.id,
            name: row.name,
            displayName: row.display_name,
            icon: row.icon || iconMap[row.name] || 'ri-bank-card-line',
            description: row.description || '',
            sortOrder: row.sort_order || 0,
            status: row.status,
            createdAt: row.created_at || '',
            updatedAt: row.updated_at || ''
        }));

        return c.json({ code: 1, data: mapped });
    } catch (error) {
        console.error('Get payment types error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 支付通道列表
 * GET /api/admin/channels
 */
adminRouter.get('/channels', async (c) => {
    try {
        const result = await c.env.DB.prepare(`
            SELECT c.*, pt.name as payment_type_name, pt.display_name as payment_type_display
            FROM channels c
            LEFT JOIN payment_types pt ON c.payment_type_id = pt.id
            ORDER BY c.sort_order ASC, c.created_at DESC
        `).all();

        const mapped = result.results.map((row: any) => ({
            id: row.id,
            paymentTypeId: row.payment_type_id,
            paymentType: row.payment_type_name || '',
            paymentTypeDisplay: row.payment_type_display || '',
            name: row.name,
            plugin: row.plugin,
            feeRate: row.fee_rate || 0,
            minAmount: row.min_amount || 0,
            maxAmount: row.max_amount || 0,
            dailyLimit: row.daily_limit || 0,
            timeStart: row.time_start,
            timeStop: row.time_stop,
            sortOrder: row.sort_order || 0,
            status: row.status,
            description: row.description || '',
            createdAt: row.created_at || '',
            updatedAt: row.updated_at || ''
        }));

        return c.json({ code: 1, data: mapped });
    } catch (error) {
        console.error('Get channels error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 创建通道
 * POST /api/admin/channels
 */
adminRouter.post('/channels', async (c) => {
    try {
        const body = await c.req.json();
        const { paymentTypeId, name, plugin, config, feeRate, minAmount, maxAmount, dailyLimit, timeStart, timeStop, sortOrder, status, description } = body;

        if (!paymentTypeId || !name || !plugin) {
            return c.json({ code: -1, msg: '支付方式、通道名称和插件标识不能为空' });
        }

        const paymentType = await c.env.DB.prepare(
            'SELECT id FROM payment_types WHERE id = ?'
        ).bind(paymentTypeId).first();

        if (!paymentType) {
            return c.json({ code: -1, msg: '支付方式不存在' });
        }

        const id = generateUUIDv7();
        const now = new Date().toISOString();

        await c.env.DB.prepare(`
            INSERT INTO channels (id, payment_type_id, name, plugin, config, fee_rate, min_amount, max_amount, daily_limit, time_start, time_stop, sort_order, status, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            id,
            paymentTypeId,
            name,
            plugin,
            config ? JSON.stringify(config) : null,
            feeRate || 0,
            minAmount || 0,
            maxAmount || 0,
            dailyLimit || 0,
            timeStart || null,
            timeStop || null,
            sortOrder || 0,
            status !== undefined ? status : 1,
            description || null,
            now,
            now
        ).run();

        return c.json({
            code: 1,
            msg: '通道创建成功',
            data: { id }
        });
    } catch (error) {
        console.error('Create channel error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 更新通道
 * PUT /api/admin/channels/:id
 */
adminRouter.put('/channels/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const body = await c.req.json();
        const { paymentTypeId, name, plugin, config, feeRate, minAmount, maxAmount, dailyLimit, timeStart, timeStop, sortOrder, status, description } = body;

        const existing = await c.env.DB.prepare(
            'SELECT id FROM channels WHERE id = ?'
        ).bind(id).first();

        if (!existing) {
            return c.json({ code: -1, msg: '通道不存在' });
        }

        if (paymentTypeId) {
            const paymentType = await c.env.DB.prepare(
                'SELECT id FROM payment_types WHERE id = ?'
            ).bind(paymentTypeId).first();

            if (!paymentType) {
                return c.json({ code: -1, msg: '支付方式不存在' });
            }
        }

        const now = new Date().toISOString();

        await c.env.DB.prepare(`
            UPDATE channels SET
                payment_type_id = COALESCE(?, payment_type_id),
                name = COALESCE(?, name),
                plugin = COALESCE(?, plugin),
                config = ?,
                fee_rate = COALESCE(?, fee_rate),
                min_amount = COALESCE(?, min_amount),
                max_amount = COALESCE(?, max_amount),
                daily_limit = COALESCE(?, daily_limit),
                time_start = ?,
                time_stop = ?,
                sort_order = COALESCE(?, sort_order),
                status = COALESCE(?, status),
                description = ?,
                updated_at = ?
            WHERE id = ?
        `).bind(
            paymentTypeId || null,
            name || null,
            plugin || null,
            config !== undefined ? JSON.stringify(config) : undefined,
            feeRate !== undefined ? feeRate : null,
            minAmount !== undefined ? minAmount : null,
            maxAmount !== undefined ? maxAmount : null,
            dailyLimit !== undefined ? dailyLimit : null,
            timeStart !== undefined ? timeStart : undefined,
            timeStop !== undefined ? timeStop : undefined,
            sortOrder !== undefined ? sortOrder : null,
            status !== undefined ? status : null,
            description !== undefined ? description : undefined,
            now,
            id
        ).run();

        return c.json({ code: 1, msg: '通道更新成功' });
    } catch (error) {
        console.error('Update channel error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 删除通道
 * DELETE /api/admin/channels/:id
 */
adminRouter.delete('/channels/:id', async (c) => {
    try {
        const id = c.req.param('id');

        const existing = await c.env.DB.prepare(
            'SELECT id FROM channels WHERE id = ?'
        ).bind(id).first();

        if (!existing) {
            return c.json({ code: -1, msg: '通道不存在' });
        }

        const orderCount = await c.env.DB.prepare(
            'SELECT COUNT(*) as count FROM orders WHERE channel_id = ?'
        ).bind(id).first();

        if ((orderCount as any)?.count > 0) {
            return c.json({ code: -1, msg: '该通道存在关联订单，无法删除' });
        }

        await c.env.DB.prepare(
            'DELETE FROM channels WHERE id = ?'
        ).bind(id).run();

        return c.json({ code: 1, msg: '通道删除成功' });
    } catch (error) {
        console.error('Delete channel error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 切换通道状态
 * PATCH /api/admin/channels/:id/status
 */
adminRouter.patch('/channels/:id/status', async (c) => {
    try {
        const id = c.req.param('id');
        const body = await c.req.json();
        const { status } = body;

        if (status !== 0 && status !== 1) {
            return c.json({ code: -1, msg: '状态值无效' });
        }

        const existing = await c.env.DB.prepare(
            'SELECT id FROM channels WHERE id = ?'
        ).bind(id).first();

        if (!existing) {
            return c.json({ code: -1, msg: '通道不存在' });
        }

        const now = new Date().toISOString();

        await c.env.DB.prepare(
            'UPDATE channels SET status = ?, updated_at = ? WHERE id = ?'
        ).bind(status, now, id).run();

        return c.json({ code: 1, msg: status === 1 ? '通道已启用' : '通道已禁用' });
    } catch (error) {
        console.error('Toggle channel status error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 操作日志列表
 * GET /api/admin/logs
 */
adminRouter.get('/logs', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    const keyword = c.req.query('keyword');

    try {
        let query = `
            SELECT l.*, u.username 
            FROM operation_logs l 
            LEFT JOIN users u ON l.user_id = u.id 
            WHERE 1=1
        `;
        const params: any[] = [];

        if (keyword) {
            query += ' AND (l.action LIKE ? OR l.target LIKE ? OR l.detail LIKE ? OR u.username LIKE ?)';
            const likeKeyword = `%${keyword}%`;
            params.push(likeKeyword, likeKeyword, likeKeyword, likeKeyword);
        }

        query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const result = await c.env.DB.prepare(query).bind(...params).all();

        const mapped = result.results.map((row: any) => ({
            id: row.id,
            userId: row.user_id || '',
            user: row.username || '系统',
            action: row.action || '',
            target: row.target || '',
            detail: row.detail || '',
            ip: row.ip || '',
            userAgent: row.user_agent || '',
            createdAt: row.created_at || ''
        }));

        return c.json({ code: 1, data: mapped });
    } catch (error) {
        console.error('Get logs error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
