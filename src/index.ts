/**
 * Teaven Pay - Cloudflare Workers 易支付系统
 * 入口文件
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';

// 路由
import { payRouter } from './routes/pay';
import { merchantRouter } from './routes/merchant';
import { adminRouter } from './routes/admin';
import { notifyRouter } from './routes/notify';

// 中间件
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';

// 类型
import { Env } from './types/env';

const app = new Hono<{ Bindings: Env }>();

// 全局中间件
app.use('*', timing());
app.use('*', logger());
app.use('*', secureHeaders());

// CORS 配置
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 86400,
    credentials: true,
}));

// 错误处理
app.onError(errorHandler);

// 健康检查
app.get('/api/health', (c) => {
    return c.json({
        status: 'ok',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
});

// 管理后台 API (不需要认证，用于管理后台页面)
app.get('/api/admin/stats', async (c) => {
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
        return c.json({ 
            code: 1, 
            data: {
                today: { orders: 0, success_orders: 0, amount: 0, profit: 0 },
                merchants: { total: 0, active: 0, pending: 0 },
                total: { orders: 0, amount: 0 }
            }
        });
    }
});

// API 路由
app.route('/api/pay', payRouter);
app.route('/api/merchant', merchantRouter);
app.route('/api/admin', adminRouter);

// 兼容易支付标准接口
app.route('/notify', notifyRouter);

// 易支付标准接口 - submit.php
app.post('/submit.php', async (c) => {
    const router = payRouter;
    return router.fetch(c.req.raw, c.env);
});

// 易支付标准接口 - api.php
app.all('/api.php', async (c) => {
    const act = c.req.query('act');
    
    switch (act) {
        case 'submit':
            // 转发到支付接口
            const submitReq = new Request(c.req.url.replace('/api.php', '/api/pay/submit'), {
                method: 'POST',
                headers: c.req.raw.headers,
                body: c.req.raw.body,
            });
            return payRouter.fetch(submitReq, c.env);
            
        case 'query':
        case 'order':
        case 'orders':
            // 转发到查询接口
            const queryReq = new Request(c.req.url.replace('/api.php', '/api/pay/query'), {
                method: 'GET',
                headers: c.req.raw.headers,
            });
            return payRouter.fetch(queryReq, c.env);
            
        case 'settle':
            // 转发到结算接口
            const settleReq = new Request(c.req.url.replace('/api.php', '/api/merchant/settle'), {
                method: 'GET',
                headers: c.req.raw.headers,
            });
            return merchantRouter.fetch(settleReq, c.env);
            
        case 'refund':
            // 转发到退款接口
            const refundReq = new Request(c.req.url.replace('/api.php', '/api/pay/refund'), {
                method: 'POST',
                headers: c.req.raw.headers,
                body: c.req.raw.body,
            });
            return payRouter.fetch(refundReq, c.env);
            
        case 'refundquery':
            // 转发到退款查询接口
            const refundQueryReq = new Request(c.req.url.replace('/api.php', '/api/pay/refund/query'), {
                method: 'GET',
                headers: c.req.raw.headers,
            });
            return payRouter.fetch(refundQueryReq, c.env);
            
        case 'close':
            // 转发到关闭订单接口
            const closeReq = new Request(c.req.url.replace('/api.php', '/api/pay/close'), {
                method: 'POST',
                headers: c.req.raw.headers,
                body: c.req.raw.body,
            });
            return payRouter.fetch(closeReq, c.env);
            
        default:
            return c.json({ code: -5, msg: 'No Act!' }, 400);
    }
});

// 收银台页面
app.get('/cashier/:tradeNo', async (c) => {
    const { tradeNo } = c.req.param();
    // TODO: 返回收银台页面
    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>收银台 - Teaven Pay</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body>
            <h1>收银台</h1>
            <p>订单号: ${tradeNo}</p>
            <!-- TODO: 实现收银台页面 -->
        </body>
        </html>
    `);
});

// 支付结果页面
app.get('/result/:tradeNo', async (c) => {
    const { tradeNo } = c.req.param();
    // TODO: 返回支付结果页面
    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>支付结果 - Teaven Pay</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body>
            <h1>支付结果</h1>
            <p>订单号: ${tradeNo}</p>
            <!-- TODO: 实现支付结果页面 -->
        </body>
        </html>
    `);
});

// 管理后台页面
app.get('/admin', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Teaven Pay - 管理后台</title>
    <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/remixicon/4.0.0/remixicon.min.css">
    <script src="https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js"></script>
    <style>
        /* CSS 变量 */
        :root {
            /* 主题色 */
            --primary-50: #fffbeb;
            --primary-100: #fef3c7;
            --primary-200: #fde68a;
            --primary-300: #fcd34d;
            --primary-400: #fbbf24;
            --primary-500: #f59e0b;
            --primary-600: #d97706;
            --primary-700: #b45309;
            --primary-800: #92400e;
            --primary-900: #78350f;

            /* 状态色 */
            --success: #10b981;
            --warning: #f59e0b;
            --error: #ef4444;
            --info: #3b82f6;
            --default: #6b7280;

            /* 中性色 */
            --gray-50: #f9fafb;
            --gray-100: #f3f4f6;
            --gray-200: #e5e7eb;
            --gray-300: #d1d5db;
            --gray-400: #9ca3af;
            --gray-500: #6b7280;
            --gray-600: #4b5563;
            --gray-700: #374151;
            --gray-800: #1f2937;
            --gray-900: #111827;

            /* 亮色模式 */
            --bg-primary: #ffffff;
            --bg-secondary: #f9fafb;
            --bg-tertiary: #f3f4f6;
            --text-primary: #111827;
            --text-secondary: #4b5563;
            --text-tertiary: #9ca3af;
            --border-color: #e5e7eb;
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);

            /* 布局 */
            --sidebar-width: 240px;
            --sidebar-collapsed-width: 64px;
            --header-height: 56px;
        }

        /* 深色模式 */
        [data-theme="dark"] {
            --bg-primary: #111827;
            --bg-secondary: #1f2937;
            --bg-tertiary: #374151;
            --text-primary: #f9fafb;
            --text-secondary: #d1d5db;
            --text-tertiary: #9ca3af;
            --border-color: #374151;
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -1px rgba(0, 0, 0, 0.3);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -2px rgba(0, 0, 0, 0.3);
        }

        /* 基础样式 */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
            background-color: var(--bg-secondary);
            color: var(--text-primary);
            line-height: 1.5;
            font-size: 14px;
        }

        /* 布局 */
        .layout {
            display: flex;
            min-height: 100vh;
        }

        /* 侧边栏 */
        .sidebar {
            width: var(--sidebar-width);
            background-color: var(--bg-primary);
            border-right: 1px solid var(--border-color);
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: 100;
            transition: width 0.3s ease;
            display: flex;
            flex-direction: column;
        }

        .sidebar.collapsed {
            width: var(--sidebar-collapsed-width);
        }

        .sidebar-header {
            height: var(--header-height);
            display: flex;
            align-items: center;
            padding: 0 16px;
            border-bottom: 1px solid var(--border-color);
        }

        .sidebar-logo {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text-primary);
            font-weight: 600;
            font-size: 16px;
        }

        .sidebar-logo i {
            font-size: 24px;
            color: var(--primary-500);
        }

        .sidebar.collapsed .sidebar-logo span {
            display: none;
        }

        .sidebar-nav {
            flex: 1;
            padding: 12px 8px;
            overflow-y: auto;
        }

        .nav-section {
            margin-bottom: 24px;
        }

        .nav-section-title {
            padding: 0 12px;
            margin-bottom: 8px;
            font-size: 12px;
            font-weight: 500;
            color: var(--text-tertiary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .sidebar.collapsed .nav-section-title {
            display: none;
        }

        .nav-item {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            margin-bottom: 2px;
            border-radius: 6px;
            color: var(--text-secondary);
            text-decoration: none;
            transition: all 0.2s ease;
            cursor: pointer;
        }

        .nav-item:hover {
            background-color: var(--bg-tertiary);
            color: var(--text-primary);
        }

        .nav-item.active {
            background-color: var(--primary-50);
            color: var(--primary-600);
        }

        [data-theme="dark"] .nav-item.active {
            background-color: rgba(245, 158, 11, 0.1);
        }

        .nav-item i {
            font-size: 18px;
            width: 24px;
            margin-right: 12px;
        }

        .sidebar.collapsed .nav-item i {
            margin-right: 0;
        }

        .sidebar.collapsed .nav-item span {
            display: none;
        }

        .nav-item .badge {
            margin-left: auto;
            background-color: var(--error);
            color: white;
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 10px;
        }

        .sidebar.collapsed .nav-item .badge {
            display: none;
        }

        /* 主内容区 */
        .main-content {
            flex: 1;
            margin-left: var(--sidebar-width);
            transition: margin-left 0.3s ease;
            display: flex;
            flex-direction: column;
            min-height: 100vh;
        }

        .sidebar.collapsed ~ .main-content {
            margin-left: var(--sidebar-collapsed-width);
        }

        /* 头部 */
        .header {
            height: var(--header-height);
            background-color: var(--bg-primary);
            border-bottom: 1px solid var(--border-color);
            position: sticky;
            top: 0;
            z-index: 50;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .sidebar-toggle {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 8px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .sidebar-toggle:hover {
            background-color: var(--bg-tertiary);
        }

        .breadcrumb {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
        }

        .breadcrumb a {
            color: var(--text-tertiary);
            text-decoration: none;
        }

        .breadcrumb a:hover {
            color: var(--text-primary);
        }

        .breadcrumb .separator {
            color: var(--text-tertiary);
        }

        .breadcrumb .current {
            color: var(--text-primary);
            font-weight: 500;
        }

        .header-right {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .theme-toggle {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 8px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .theme-toggle:hover {
            background-color: var(--bg-tertiary);
        }

        .user-menu {
            position: relative;
        }

        .user-menu-button {
            display: flex;
            align-items: center;
            gap: 8px;
            background: none;
            border: none;
            color: var(--text-primary);
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 6px;
        }

        .user-menu-button:hover {
            background-color: var(--bg-tertiary);
        }

        .user-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background-color: var(--primary-500);
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 500;
        }

        .user-menu-dropdown {
            position: absolute;
            top: 100%;
            right: 0;
            background-color: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 8px 0;
            min-width: 160px;
            box-shadow: var(--shadow-lg);
            display: none;
            z-index: 100;
        }

        .user-menu:hover .user-menu-dropdown {
            display: block;
        }

        .dropdown-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            color: var(--text-secondary);
            text-decoration: none;
            transition: background-color 0.2s ease;
        }

        .dropdown-item:hover {
            background-color: var(--bg-tertiary);
            color: var(--text-primary);
        }

        /* 内容区 */
        .content {
            flex: 1;
            padding: 24px;
        }

        .page-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
        }

        .page-title {
            font-size: 24px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .page-actions {
            display: flex;
            gap: 12px;
        }

        /* 组件样式 */
        .card {
            background-color: var(--bg-primary);
            border-radius: 8px;
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-sm);
            overflow: hidden;
        }

        .card-header {
            padding: 16px 20px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .card-title {
            font-size: 16px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .card-body {
            padding: 20px;
        }

        .card-footer {
            padding: 12px 20px;
            border-top: 1px solid var(--border-color);
            background-color: var(--bg-secondary);
        }

        /* 统计卡片 */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-card {
            background-color: var(--bg-primary);
            border-radius: 8px;
            border: 1px solid var(--border-color);
            padding: 20px;
            box-shadow: var(--shadow-sm);
        }

        .stat-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }

        .stat-label {
            font-size: 14px;
            color: var(--text-secondary);
        }

        .stat-icon {
            width: 40px;
            height: 40px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
        }

        .stat-icon.green {
            background-color: var(--primary-100);
            color: var(--primary-600);
        }

        .stat-icon.blue {
            background-color: #dbeafe;
            color: #2563eb;
        }

        .stat-icon.yellow {
            background-color: #fef3c7;
            color: #d97706;
        }

        .stat-icon.purple {
            background-color: #ede9fe;
            color: #7c3aed;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 4px;
        }

        .stat-change {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
        }

        .stat-change.up {
            color: var(--success);
        }

        .stat-change.down {
            color: var(--error);
        }

        /* 表格 */
        .table-container {
            overflow-x: auto;
        }

        .data-table {
            width: 100%;
            border-collapse: collapse;
        }

        .data-table th {
            padding: 12px 16px;
            text-align: left;
            font-weight: 500;
            color: var(--text-secondary);
            background-color: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            white-space: nowrap;
        }

        .data-table td {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            white-space: nowrap;
        }

        .data-table tr:hover {
            background-color: var(--bg-secondary);
        }

        .data-table tr:last-child td {
            border-bottom: none;
        }

        /* 状态标签 */
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }

        .badge.success {
            background-color: #dcfce7;
            color: #166534;
        }

        .badge.warning {
            background-color: #fef3c7;
            color: #92400e;
        }

        .badge.error {
            background-color: #fee2e2;
            color: #991b1b;
        }

        .badge.info {
            background-color: #dbeafe;
            color: #1e40af;
        }

        .badge.default {
            background-color: #f3f4f6;
            color: #374151;
        }

        [data-theme="dark"] .badge.success {
            background-color: rgba(34, 197, 94, 0.2);
            color: #4ade80;
        }

        [data-theme="dark"] .badge.warning {
            background-color: rgba(245, 158, 11, 0.2);
            color: #fbbf24;
        }

        [data-theme="dark"] .badge.error {
            background-color: rgba(239, 68, 68, 0.2);
            color: #f87171;
        }

        [data-theme="dark"] .badge.info {
            background-color: rgba(59, 130, 246, 0.2);
            color: #60a5fa;
        }

        [data-theme="dark"] .badge.default {
            background-color: rgba(107, 114, 128, 0.2);
            color: #9ca3af;
        }

        /* 按钮 */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            border: 1px solid transparent;
        }

        .btn-primary {
            background-color: var(--primary-500);
            color: white;
        }

        .btn-primary:hover {
            background-color: var(--primary-600);
        }

        .btn-secondary {
            background-color: transparent;
            color: var(--text-primary);
            border-color: var(--border-color);
        }

        .btn-secondary:hover {
            background-color: var(--bg-tertiary);
        }

        .btn-danger {
            background-color: var(--error);
            color: white;
        }

        .btn-danger:hover {
            background-color: #dc2626;
        }

        .btn-sm {
            padding: 6px 12px;
            font-size: 12px;
        }

        .btn-lg {
            padding: 12px 24px;
            font-size: 16px;
        }

        .btn-icon {
            padding: 8px;
        }

        /* 表单 */
        .form-group {
            margin-bottom: 16px;
        }

        .form-label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            color: var(--text-primary);
        }

        .form-input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-size: 14px;
            transition: border-color 0.2s ease;
        }

        .form-input:focus {
            outline: none;
            border-color: var(--primary-500);
            box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.1);
        }

        .form-input::placeholder {
            color: var(--text-tertiary);
        }

        .form-select {
            appearance: none;
            background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%23343a40' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M2 5l6 6 6-6'/%3e%3c/svg%3e");
            background-repeat: no-repeat;
            background-position: right 12px center;
            background-size: 12px 12px;
            padding-right: 36px;
        }

        .form-textarea {
            min-height: 100px;
            resize: vertical;
        }

        .form-hint {
            margin-top: 4px;
            font-size: 12px;
            color: var(--text-tertiary);
        }

        .form-error {
            margin-top: 4px;
            font-size: 12px;
            color: var(--error);
        }

        /* 筛选栏 */
        .filter-bar {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }

        .filter-bar .form-input {
            width: auto;
            min-width: 200px;
        }

        .filter-bar .form-select {
            width: auto;
            min-width: 150px;
        }

        /* 分页 */
        .pagination {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 0;
        }

        .pagination-info {
            font-size: 14px;
            color: var(--text-secondary);
        }

        .pagination-buttons {
            display: flex;
            gap: 8px;
        }

        .pagination-btn {
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .pagination-btn:hover {
            background-color: var(--bg-tertiary);
        }

        .pagination-btn.active {
            background-color: var(--primary-500);
            color: white;
            border-color: var(--primary-500);
        }

        .pagination-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* 图表容器 */
        .chart-container {
            height: 300px;
            position: relative;
        }

        .chart-placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            background-color: var(--bg-tertiary);
            border-radius: 8px;
            color: var(--text-tertiary);
        }

        /* 模态框 */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            opacity: 0;
            visibility: hidden;
            transition: all 0.3s ease;
        }

        .modal-overlay.active {
            opacity: 1;
            visibility: visible;
        }

        .modal {
            background-color: var(--bg-primary);
            border-radius: 12px;
            box-shadow: var(--shadow-lg);
            width: 100%;
            max-width: 500px;
            max-height: 90vh;
            overflow: hidden;
            transform: scale(0.9);
            transition: transform 0.3s ease;
        }

        .modal-overlay.active .modal {
            transform: scale(1);
        }

        .modal-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .modal-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .modal-close {
            background: none;
            border: none;
            color: var(--text-tertiary);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
        }

        .modal-close:hover {
            color: var(--text-primary);
            background-color: var(--bg-tertiary);
        }

        .modal-body {
            padding: 24px;
            overflow-y: auto;
            max-height: calc(90vh - 130px);
        }

        .modal-footer {
            padding: 16px 24px;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: flex-end;
            gap: 12px;
        }

        /* Toast */
        .toast-container {
            position: fixed;
            top: 24px;
            right: 24px;
            z-index: 2000;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .toast {
            background-color: var(--bg-primary);
            border-radius: 8px;
            box-shadow: var(--shadow-lg);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            min-width: 300px;
            max-width: 400px;
            transform: translateX(100%);
            opacity: 0;
            transition: all 0.3s ease;
        }

        .toast.show {
            transform: translateX(0);
            opacity: 1;
        }

        .toast.success {
            border-left: 4px solid var(--success);
        }

        .toast.error {
            border-left: 4px solid var(--error);
        }

        .toast.warning {
            border-left: 4px solid var(--warning);
        }

        .toast.info {
            border-left: 4px solid var(--info);
        }

        .toast-icon {
            font-size: 20px;
        }

        .toast.success .toast-icon {
            color: var(--success);
        }

        .toast.error .toast-icon {
            color: var(--error);
        }

        .toast.warning .toast-icon {
            color: var(--warning);
        }

        .toast.info .toast-icon {
            color: var(--info);
        }

        .toast-content {
            flex: 1;
        }

        .toast-title {
            font-weight: 500;
            color: var(--text-primary);
            margin-bottom: 2px;
        }

        .toast-message {
            font-size: 13px;
            color: var(--text-secondary);
        }

        .toast-close {
            background: none;
            border: none;
            color: var(--text-tertiary);
            cursor: pointer;
            padding: 4px;
        }

        .toast-close:hover {
            color: var(--text-primary);
        }

        /* 加载状态 */
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 40px;
        }

        .spinner {
            width: 24px;
            height: 24px;
            border: 3px solid var(--border-color);
            border-top-color: var(--primary-500);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to {
                transform: rotate(360deg);
            }
        }

        /* 空状态 */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px;
            color: var(--text-tertiary);
        }

        .empty-state i {
            font-size: 48px;
            margin-bottom: 16px;
        }

        .empty-state p {
            font-size: 14px;
        }

        /* 工具栏 */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }

        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .toolbar-right {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        /* 侧边栏底部 */
        .sidebar-footer {
            padding: 16px;
            border-top: 1px solid var(--border-color);
        }

        .sidebar-footer .nav-item {
            margin-bottom: 0;
        }

        /* 移动端抽屉 */
        .drawer-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 99;
            display: none;
        }

        .drawer-overlay.active {
            display: block;
        }

        /* 抽屉样式 */
        .drawer-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            display: none;
        }

        .drawer-overlay.active {
            display: block;
        }

        /* 响应式 */
        @media (max-width: 1024px) {
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }

            .sidebar {
                transform: translateX(-100%);
            }

            .sidebar.mobile-open {
                transform: translateX(0);
            }

            .main-content {
                margin-left: 0;
            }

            .sidebar.collapsed ~ .main-content {
                margin-left: 0;
            }

            .filter-bar {
                flex-direction: column;
            }

            .filter-bar .form-input,
            .filter-bar .form-select {
                width: 100%;
            }
        }

        @media (max-width: 768px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }

            .page-header {
                flex-direction: column;
                gap: 16px;
                align-items: flex-start;
            }

            .page-actions {
                width: 100%;
            }

            .page-actions .btn {
                flex: 1;
            }

            .header {
                padding: 0 16px;
            }

            .content {
                padding: 16px;
            }

            .breadcrumb {
                display: none;
            }
        }

        @media (max-width: 480px) {
            .stat-value {
                font-size: 24px;
            }

            .modal {
                margin: 16px;
            }

            .card-header {
                flex-direction: column;
                gap: 12px;
                align-items: flex-start;
            }

            .card-header .btn {
                width: 100%;
            }

            .filter-bar {
                flex-direction: column;
            }

            .filter-bar .form-input,
            .filter-bar .form-select {
                width: 100%;
            }

            .pagination {
                flex-direction: column;
                gap: 12px;
            }

            .pagination-buttons {
                width: 100%;
                justify-content: center;
            }
        }

        /* 动画 */
        .fade-in {
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* 页脚 */
        .footer {
            padding: 16px 24px;
            border-top: 1px solid var(--border-color);
            background-color: var(--bg-primary);
            text-align: center;
            font-size: 12px;
            color: var(--text-tertiary);
        }
    </style>
</head>
<body>
    <div class="layout">
        <!-- 侧边栏 -->
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <a href="/admin" class="sidebar-logo">
                    <i class="ri-bank-card-line"></i>
                    <span>Teaven Pay</span>
                </a>
            </div>
            <nav class="sidebar-nav">
                <div class="nav-section">
                    <div class="nav-section-title">概览</div>
                    <a href="#" class="nav-item active" data-page="dashboard">
                        <i class="ri-dashboard-line"></i>
                        <span>仪表盘</span>
                    </a>
                </div>
                <div class="nav-section">
                    <div class="nav-section-title">业务管理</div>
                    <a href="#" class="nav-item" data-page="merchants">
                        <i class="ri-store-2-line"></i>
                        <span>商户管理</span>
                        <span class="badge">12</span>
                    </a>
                    <a href="#" class="nav-item" data-page="orders">
                        <i class="ri-file-list-3-line"></i>
                        <span>订单管理</span>
                    </a>
                    <a href="#" class="nav-item" data-page="settlements">
                        <i class="ri-money-cny-circle-line"></i>
                        <span>结算管理</span>
                        <span class="badge">5</span>
                    </a>
                </div>
                <div class="nav-section">
                    <div class="nav-section-title">支付配置</div>
                    <a href="#" class="nav-item" data-page="payment-types">
                        <i class="ri-alipay-line"></i>
                        <span>支付方式</span>
                    </a>
                    <a href="#" class="nav-item" data-page="channels">
                        <i class="ri-links-line"></i>
                        <span>支付通道</span>
                    </a>
                </div>
                <div class="nav-section">
                    <div class="nav-section-title">系统</div>
                    <a href="#" class="nav-item" data-page="settings">
                        <i class="ri-settings-3-line"></i>
                        <span>系统配置</span>
                    </a>
                    <a href="#" class="nav-item" data-page="logs">
                        <i class="ri-history-line"></i>
                        <span>操作日志</span>
                    </a>
                </div>
            </nav>
            <div class="sidebar-footer">
                <a href="#" class="nav-item">
                    <i class="ri-question-line"></i>
                    <span>帮助中心</span>
                </a>
            </div>
        </aside>

        <!-- 移动端遮罩 -->
        <div class="drawer-overlay" id="drawerOverlay"></div>

        <!-- 主内容区 -->
        <div class="main-content">
            <!-- 头部 -->
            <header class="header">
                <div class="header-left">
                    <button class="sidebar-toggle" id="sidebarToggle">
                        <i class="ri-menu-line"></i>
                    </button>
                    <div class="breadcrumb">
                        <a href="/admin">首页</a>
                        <span class="separator">/</span>
                        <span class="current" id="breadcrumbCurrent">仪表盘</span>
                    </div>
                </div>
                <div class="header-right">
                    <button class="theme-toggle" id="themeToggle">
                        <i class="ri-moon-line"></i>
                    </button>
                    <div class="user-menu">
                        <button class="user-menu-button">
                            <div class="user-avatar">管</div>
                            <span>管理员</span>
                            <i class="ri-arrow-down-s-line"></i>
                        </button>
                        <div class="user-menu-dropdown">
                            <a href="#" class="dropdown-item">
                                <i class="ri-user-line"></i>
                                <span>个人信息</span>
                            </a>
                            <a href="#" class="dropdown-item">
                                <i class="ri-settings-3-line"></i>
                                <span>账号设置</span>
                            </a>
                            <a href="#" class="dropdown-item">
                                <i class="ri-logout-box-r-line"></i>
                                <span>退出登录</span>
                            </a>
                        </div>
                    </div>
                </div>
            </header>

            <!-- 内容区 -->
            <main class="content" id="mainContent">
                <!-- 页面内容将通过 JavaScript 动态加载 -->
            </main>

            <!-- 页脚 -->
            <footer class="footer">
                <p>Teaven Pay 管理后台 &copy; 2026. 基于 Cloudflare Workers 构建.</p>
            </footer>
        </div>
    </div>

    <!-- Toast 容器 -->
    <div class="toast-container" id="toastContainer"></div>

    <script>
        // 应用状态
        const state = {
            currentPage: 'dashboard',
            sidebarCollapsed: false,
            theme: 'light',
            merchants: [],
            orders: [],
            settlements: [],
            logs: []
        };

        // API 服务
        const api = {
            // 获取统计数据
            async getStats() {
                try {
                    const response = await fetch('/api/admin/stats');
                    const data = await response.json();
                    if (data.code === 1) {
                        return data.data;
                    }
                    throw new Error(data.msg || '获取统计数据失败');
                } catch (error) {
                    console.error('获取统计数据失败:', error);
                    // 返回模拟数据作为后备
                    return {
                        today: { orders: 1234, success_orders: 1189, amount: 89012.50, profit: 1234.56 },
                        merchants: { total: 156, active: 142, pending: 12 },
                        total: { orders: 45678, amount: 3456789.00 }
                    };
                }
            },

            // 获取商户列表
            async getMerchants(params = {}) {
                try {
                    const queryString = new URLSearchParams(params).toString();
                    const response = await fetch('/api/admin/merchants?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { count: data.count, data: data.data };
                    }
                    throw new Error(data.msg || '获取商户列表失败');
                } catch (error) {
                    console.error('获取商户列表失败:', error);
                    return { count: 5, data: mockData.merchants };
                }
            },

            // 创建商户
            async createMerchant(merchantData) {
                try {
                    const response = await fetch('/api/admin/merchants', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams(merchantData)
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true, data: data.data };
                    }
                    throw new Error(data.msg || '创建商户失败');
                } catch (error) {
                    console.error('创建商户失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 更新商户状态
            async updateMerchantStatus(id, status) {
                try {
                    const response = await fetch('/api/admin/merchants/' + id + '/status', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({ status })
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '更新状态失败');
                } catch (error) {
                    console.error('更新状态失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 获取订单列表
            async getOrders(params = {}) {
                try {
                    const queryString = new URLSearchParams(params).toString();
                    const response = await fetch('/api/admin/orders?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取订单列表失败');
                } catch (error) {
                    console.error('获取订单列表失败:', error);
                    return { data: mockData.orders };
                }
            },

            // 获取结算列表
            async getSettlements(params = {}) {
                try {
                    const queryString = new URLSearchParams(params).toString();
                    const response = await fetch('/api/admin/settlements?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取结算列表失败');
                } catch (error) {
                    console.error('获取结算列表失败:', error);
                    return { data: mockData.settlements };
                }
            },

            // 处理结算
            async processSettlement(id, action, reason) {
                try {
                    const response = await fetch('/api/admin/settlements/' + id, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({ action, reason })
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true, message: data.msg };
                    }
                    throw new Error(data.msg || '处理结算失败');
                } catch (error) {
                    console.error('处理结算失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 获取系统配置
            async getConfig() {
                try {
                    const response = await fetch('/api/admin/config');
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true, data: data.data };
                    }
                    throw new Error(data.msg || '获取配置失败');
                } catch (error) {
                    console.error('获取配置失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 更新系统配置
            async updateConfig(configData) {
                try {
                    const response = await fetch('/api/admin/config', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams(configData)
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '更新配置失败');
                } catch (error) {
                    console.error('更新配置失败:', error);
                    return { success: false, message: error.message };
                }
            }
        };

        // 模拟数据
        const mockData = {
            merchants: [
                { id: 'm_001', username: '杭州星辰科技', email: 'xingchen@example.com', status: 1, balance: 15680.50, apiKey: 'sk_live_xxxx1234', createdAt: '2024-01-15 10:30:00' },
                { id: 'm_002', username: '上海云端网络', email: 'yunduan@example.com', status: 1, balance: 8920.75, apiKey: 'sk_live_xxxx5678', createdAt: '2024-02-20 14:15:00' },
                { id: 'm_003', username: '深圳创新科技', email: 'chuangxin@example.com', status: 2, balance: 0, apiKey: 'sk_live_xxxx9012', createdAt: '2024-03-10 09:45:00' },
                { id: 'm_004', username: '北京智慧支付', email: 'zhihui@example.com', status: 1, balance: 23450.00, apiKey: 'sk_live_xxxx3456', createdAt: '2024-04-05 16:20:00' },
                { id: 'm_005', username: '广州数字科技', email: 'shuzi@example.com', status: 0, balance: 1250.30, apiKey: 'sk_live_xxxx7890', createdAt: '2024-05-12 11:10:00' }
            ],
            orders: [
                { tradeNo: '202606221234567890', outTradeNo: 'ORD_20260622_001', merchant: '杭州星辰科技', paymentType: 'alipay', amount: 299.00, status: 1, createdAt: '2026-06-22 14:30:00', paidAt: '2026-06-22 14:31:25' },
                { tradeNo: '202606221234567891', outTradeNo: 'ORD_20260622_002', merchant: '上海云端网络', paymentType: 'wxpay', amount: 158.50, status: 1, createdAt: '2026-06-22 15:20:00', paidAt: '2026-06-22 15:21:10' },
                { tradeNo: '202606221234567892', outTradeNo: 'ORD_20260622_003', merchant: '北京智慧支付', paymentType: 'qqpay', amount: 88.00, status: 0, createdAt: '2026-06-22 16:10:00', paidAt: null },
                { tradeNo: '202606221234567893', outTradeNo: 'ORD_20260622_004', merchant: '杭州星辰科技', paymentType: 'alipay', amount: 999.00, status: 2, createdAt: '2026-06-22 17:05:00', paidAt: '2026-06-22 17:06:30' },
                { tradeNo: '202606221234567894', outTradeNo: 'ORD_20260622_005', merchant: '深圳创新科技', paymentType: 'wxpay', amount: 456.78, status: 3, createdAt: '2026-06-22 18:30:00', paidAt: null }
            ],
            settlements: [
                { id: 's_001', merchant: '杭州星辰科技', amount: 5000.00, status: 0, bankInfo: '工商银行 ****1234', createdAt: '2026-06-22 10:00:00', processedAt: null },
                { id: 's_002', merchant: '上海云端网络', amount: 3000.00, status: 2, bankInfo: '建设银行 ****5678', createdAt: '2026-06-21 15:30:00', processedAt: '2026-06-22 09:00:00' },
                { id: 's_003', merchant: '北京智慧支付', amount: 8000.00, status: 1, bankInfo: '农业银行 ****9012', createdAt: '2026-06-20 11:20:00', processedAt: '2026-06-21 14:30:00' },
                { id: 's_004', merchant: '广州数字科技', amount: 1500.00, status: 3, bankInfo: '中国银行 ****3456', createdAt: '2026-06-19 16:45:00', processedAt: '2026-06-20 10:15:00' }
            ],
            paymentTypes: [
                { id: 'pt_001', name: 'alipay', displayName: '支付宝', icon: 'ri-alipay-line', status: 1, sortOrder: 1 },
                { id: 'pt_002', name: 'wxpay', displayName: '微信支付', icon: 'ri-wechat-pay-line', status: 1, sortOrder: 2 },
                { id: 'pt_003', name: 'qqpay', displayName: 'QQ钱包', icon: 'ri-qq-line', status: 1, sortOrder: 3 }
            ],
            channels: [
                { id: 'ch_001', name: '支付宝官方通道', paymentType: 'alipay', plugin: 'alipay_official', feeRate: 0.006, minAmount: 0.01, maxAmount: 50000, status: 1 },
                { id: 'ch_002', name: '微信支付官方通道', paymentType: 'wxpay', plugin: 'wxpay_official', feeRate: 0.006, minAmount: 0.01, maxAmount: 50000, status: 1 },
                { id: 'ch_003', name: 'QQ钱包官方通道', paymentType: 'qqpay', plugin: 'qqpay_official', feeRate: 0.006, minAmount: 0.01, maxAmount: 50000, status: 1 }
            ],
            logs: [
                { id: 1, user: '管理员', action: '登录系统', detail: 'IP: 192.168.1.100', ip: '192.168.1.100', createdAt: '2026-06-23 09:00:00' },
                { id: 2, user: '管理员', action: '创建商户', detail: '商户ID: m_006, 用户名: 成都科技', ip: '192.168.1.100', createdAt: '2026-06-23 09:15:00' },
                { id: 3, user: '管理员', action: '审批结算', detail: '结算ID: s_002, 金额: 3000.00', ip: '192.168.1.100', createdAt: '2026-06-23 09:30:00' },
                { id: 4, user: '管理员', action: '更新配置', detail: '系统名称更新', ip: '192.168.1.100', createdAt: '2026-06-23 10:00:00' }
            ]
        };

        // 工具函数
        function formatMoney(amount) {
            return '¥' + amount.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
        }

        function formatDate(dateStr) {
            if (!dateStr) return '-';
            return dateStr;
        }

        function getStatusBadge(status, type) {
            const statusMap = {
                order: {
                    0: { text: '未支付', class: 'default' },
                    1: { text: '已支付', class: 'success' },
                    2: { text: '已退款', class: 'warning' },
                    3: { text: '已关闭', class: 'error' }
                },
                merchant: {
                    0: { text: '已禁用', class: 'error' },
                    1: { text: '正常', class: 'success' },
                    2: { text: '待审核', class: 'warning' }
                },
                settlement: {
                    0: { text: '待处理', class: 'warning' },
                    1: { text: '已处理', class: 'info' },
                    2: { text: '已批准', class: 'success' },
                    3: { text: '已拒绝', class: 'error' }
                }
            };
            const info = statusMap[type][status] || { text: '未知', class: 'default' };
            return '<span class="badge ' + info.class + '">' + info.text + '</span>';
        }

        function getPaymentTypeIcon(type) {
            const icons = {
                alipay: 'ri-alipay-line',
                wxpay: 'ri-wechat-pay-line',
                qqpay: 'ri-qq-line'
            };
            return icons[type] || 'ri-bank-card-line';
        }

        function getPaymentTypeName(type) {
            const names = {
                alipay: '支付宝',
                wxpay: '微信支付',
                qqpay: 'QQ钱包'
            };
            return names[type] || type;
        }

        // Toast 通知
        function showToast(type, title, message) {
            const container = document.getElementById('toastContainer');
            const icons = {
                success: 'ri-check-line',
                error: 'ri-error-warning-line',
                warning: 'ri-alert-line',
                info: 'ri-information-line'
            };

            const toast = document.createElement('div');
            toast.className = 'toast ' + type;
            toast.innerHTML = '<i class="' + icons[type] + ' toast-icon"></i>' +
                '<div class="toast-content">' +
                '    <div class="toast-title">' + title + '</div>' +
                '    <div class="toast-message">' + message + '</div>' +
                '</div>' +
                '<button class="toast-close" onclick="this.parentElement.remove()">' +
                '    <i class="ri-close-line"></i>' +
                '</button>';

            container.appendChild(toast);

            // 显示动画
            setTimeout(function() { toast.classList.add('show'); }, 10);

            // 自动消失
            setTimeout(function() {
                toast.classList.remove('show');
                setTimeout(function() { toast.remove(); }, 300);
            }, 3000);
        }

        // 确认对话框
        function showConfirm(title, message, onConfirm, onCancel) {
            const confirmHTML = '<div class="modal-overlay" id="confirmOverlay">' +
                '<div class="modal" style="max-width: 400px;">' +
                '    <div class="modal-header">' +
                '        <span class="modal-title">' + title + '</span>' +
                '        <button class="modal-close" onclick="closeConfirm(false)">' +
                '            <i class="ri-close-line"></i>' +
                '        </button>' +
                '    </div>' +
                '    <div class="modal-body">' +
                '        <p style="color: var(--text-secondary);">' + message + '</p>' +
                '    </div>' +
                '    <div class="modal-footer">' +
                '        <button class="btn btn-secondary" onclick="closeConfirm(false)">取消</button>' +
                '        <button class="btn btn-danger" onclick="closeConfirm(true)">确认</button>' +
                '    </div>' +
                '</div>' +
                '</div>';

            document.body.insertAdjacentHTML('beforeend', confirmHTML);
            setTimeout(function() {
                document.getElementById('confirmOverlay').classList.add('active');
            }, 10);

            // 存储回调函数
            window.confirmCallback = { onConfirm: onConfirm, onCancel: onCancel };
        }

        // 关闭确认对话框
        function closeConfirm(confirmed) {
            var overlay = document.getElementById('confirmOverlay');
            if (overlay) {
                overlay.classList.remove('active');
                setTimeout(function() { overlay.remove(); }, 300);
            }

            // 执行回调
            if (window.confirmCallback) {
                if (confirmed && window.confirmCallback.onConfirm) {
                    window.confirmCallback.onConfirm();
                } else if (!confirmed && window.confirmCallback.onCancel) {
                    window.confirmCallback.onCancel();
                }
                window.confirmCallback = null;
            }
        }

        // 抽屉组件
        function showDrawer(title, content, options) {
            options = options || {};
            var width = options.width || '400px';
            var position = options.position || 'right';
            var drawerHTML = '<div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()">' +
                '<div class="drawer" style="width: ' + width + '; position: fixed; top: 0; ' + position + ': 0; bottom: 0; background: var(--bg-primary); box-shadow: var(--shadow-lg); z-index: 1001; transform: translateX(100%); transition: transform 0.3s ease;" onclick="event.stopPropagation()">' +
                '    <div style="padding: 20px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between;">' +
                '        <span style="font-size: 18px; font-weight: 600; color: var(--text-primary);">' + title + '</span>' +
                '        <button class="btn btn-icon btn-secondary" onclick="closeDrawer()">' +
                '            <i class="ri-close-line"></i>' +
                '        </button>' +
                '    </div>' +
                '    <div style="padding: 20px; overflow-y: auto; height: calc(100% - 80px);">' +
                '        ' + content +
                '    </div>' +
                '</div>' +
                '</div>';

            document.body.insertAdjacentHTML('beforeend', drawerHTML);
            setTimeout(function() {
                document.getElementById('drawerOverlay').classList.add('active');
                document.querySelector('.drawer').style.transform = 'translateX(0)';
            }, 10);
        }

        // 关闭抽屉
        function closeDrawer() {
            var overlay = document.getElementById('drawerOverlay');
            var drawer = document.querySelector('.drawer');
            if (drawer) {
                drawer.style.transform = 'translateX(100%)';
            }
            if (overlay) {
                overlay.classList.remove('active');
                setTimeout(function() { overlay.remove(); }, 300);
            }
        }

        // 页面渲染函数
        function renderDashboard() {
            var todayOrders = '--';
            var todayAmount = '--';
            var todayProfit = '--';
            var activeMerchants = '--';

            return '<div class="page-header">' +
                '    <h1 class="page-title">仪表盘</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-secondary" onclick="loadDashboardData()">' +
                '            <i class="ri-refresh-line"></i>' +
                '            刷新数据' +
                '        </button>' +
                '    </div>' +
                '</div>' +
                '<div class="stats-grid fade-in">' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">今日订单</span>' +
                '            <div class="stat-icon green">' +
                '                <i class="ri-file-list-3-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="todayOrders">' + todayOrders + '</div>' +
                '        <div class="stat-change up">' +
                '            <i class="ri-arrow-up-line"></i>' +
                '            <span>12.5% 较昨日</span>' +
                '        </div>' +
                '    </div>' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">今日金额</span>' +
                '            <div class="stat-icon blue">' +
                '                <i class="ri-money-cny-circle-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="todayAmount">' + todayAmount + '</div>' +
                '        <div class="stat-change up">' +
                '            <i class="ri-arrow-up-line"></i>' +
                '            <span>8.3% 较昨日</span>' +
                '        </div>' +
                '    </div>' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">今日利润</span>' +
                '            <div class="stat-icon yellow">' +
                '                <i class="ri-line-chart-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="todayProfit">' + todayProfit + '</div>' +
                '        <div class="stat-change up">' +
                '            <i class="ri-arrow-up-line"></i>' +
                '            <span>15.2% 较昨日</span>' +
                '        </div>' +
                '    </div>' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">活跃商户</span>' +
                '            <div class="stat-icon purple">' +
                '                <i class="ri-store-2-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="activeMerchants">' + activeMerchants + '</div>' +
                '        <div class="stat-change up">' +
                '            <i class="ri-arrow-up-line"></i>' +
                '            <span>3.2% 较上月</span>' +
                '        </div>' +
                '    </div>' +
                '</div>' +
                '<div style="display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px;" class="fade-in">' +
                '    <div class="card">' +
                '        <div class="card-header">' +
                '            <span class="card-title">交易趋势</span>' +
                '            <div>' +
                '                <button class="btn btn-sm btn-secondary">7天</button>' +
                '                <button class="btn btn-sm btn-primary">30天</button>' +
                '            </div>' +
                '        </div>' +
                '        <div class="card-body">' +
                '            <div class="chart-container">' +
                '                <div id="trendChart" style="width: 100%; height: 100%;"></div>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '    <div class="card">' +
                '        <div class="card-header">' +
                '            <span class="card-title">支付方式分布</span>' +
                '        </div>' +
                '        <div class="card-body">' +
                '            <div class="chart-container">' +
                '                <div id="paymentChart" style="width: 100%; height: 100%;"></div>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>' +
                '<div class="card fade-in" style="margin-bottom: 24px;">' +
                '    <div class="card-header">' +
                '        <span class="card-title">每小时订单统计</span>' +
                '        <div>' +
                '            <button class="btn btn-sm btn-secondary">今日</button>' +
                '            <button class="btn btn-sm btn-primary">昨日</button>' +
                '        </div>' +
                '    </div>' +
                '    <div class="card-body">' +
                '        <div class="chart-container">' +
                '            <div id="hourlyChart" style="width: 100%; height: 100%;"></div>' +
                '        </div>' +
                '    </div>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-header">' +
                '        <span class="card-title">最近订单</span>' +
                '        <a href="#" class="btn btn-sm btn-secondary" onclick="event.preventDefault(); navigateTo(\'orders\')">查看全部</a>' +
                '    </div>' +
                '    <div class="card-body" style="padding: 0;">' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>订单号</th>' +
                '                        <th>商户</th>' +
                '                        <th>支付方式</th>' +
                '                        <th>金额</th>' +
                '                        <th>状态</th>' +
                '                        <th>创建时间</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody>' +
                '                    <tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载仪表盘数据
        async function loadDashboardData() {
            try {
                var stats = await api.getStats();
                
                // 更新统计卡片
                var todayOrdersEl = document.getElementById('todayOrders');
                var todayAmountEl = document.getElementById('todayAmount');
                var todayProfitEl = document.getElementById('todayProfit');
                var activeMerchantsEl = document.getElementById('activeMerchants');
                
                if (todayOrdersEl) todayOrdersEl.textContent = stats.today.orders.toLocaleString();
                if (todayAmountEl) todayAmountEl.textContent = formatMoney(stats.today.amount);
                if (todayProfitEl) todayProfitEl.textContent = formatMoney(stats.today.profit);
                if (activeMerchantsEl) activeMerchantsEl.textContent = stats.merchants.active.toLocaleString();

                showToast('success', '数据已更新', '仪表盘数据已刷新');
            } catch (error) {
                console.error('加载仪表盘数据失败:', error);
                showToast('error', '加载失败', '无法获取仪表盘数据');
            }
        }

        function renderMerchants() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">商户管理</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-primary" onclick="showModal(\'createMerchant\')">' +
                '            <i class="ri-add-line"></i>' +
                '            创建商户' +
                '        </button>' +
                '    </div>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-body">' +
                '        <div class="filter-bar">' +
                '            <input type="text" class="form-input" placeholder="搜索商户ID、用户名、邮箱...">' +
                '            <select class="form-input form-select">' +
                '                <option value="">全部状态</option>' +
                '                <option value="1">正常</option>' +
                '                <option value="2">待审核</option>' +
                '                <option value="0">已禁用</option>' +
                '            </select>' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-search-line"></i>' +
                '                搜索' +
                '            </button>' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-refresh-line"></i>' +
                '                重置' +
                '            </button>' +
                '        </div>' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>商户ID</th>' +
                '                        <th>用户名</th>' +
                '                        <th>邮箱</th>' +
                '                        <th>状态</th>' +
                '                        <th>余额</th>' +
                '                        <th>API Key</th>' +
                '                        <th>创建时间</th>' +
                '                        <th>操作</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody id="merchantsTableBody">' +
                '                    <tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info" id="merchantsCount">共 0 条记录</div>' +
                '            <div class="pagination-buttons">' +
                '                <button class="pagination-btn" disabled>&lt;</button>' +
                '                <button class="pagination-btn active">1</button>' +
                '                <button class="pagination-btn">&gt;</button>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载商户数据
        async function loadMerchantsData() {
            try {
                var result = await api.getMerchants();
                var tbody = document.getElementById('merchantsTableBody');
                var countEl = document.getElementById('merchantsCount');
                
                if (!tbody) return;
                
                var html = '';
                result.data.forEach(function(merchant) {
                    html += '<tr>' +
                        '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">' + merchant.id + '</code></td>' +
                        '<td>' + merchant.username + '</td>' +
                        '<td>' + merchant.email + '</td>' +
                        '<td>' + getStatusBadge(merchant.status, 'merchant') + '</td>' +
                        '<td>' + formatMoney(merchant.balance) + '</td>' +
                        '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 12px;">' + merchant.apiKey.substring(0, 12) + '...</code></td>' +
                        '<td>' + formatDate(merchant.createdAt) + '</td>' +
                        '<td>' +
                        '    <div style="display: flex; gap: 8px;">' +
                        '        <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'查看详情\', \'商户详情页面开发中\')">' +
                        '            <i class="ri-eye-line"></i>' +
                        '        </button>' +
                        '        <button class="btn btn-sm btn-secondary" onclick="showToast(\'success\', \'操作成功\', \'API Key 已重置\')">' +
                        '            <i class="ri-refresh-line"></i>' +
                        '        </button>' +
                        '    </div>' +
                        '</td>' +
                        '</tr>';
                });
                
                tbody.innerHTML = html;
                if (countEl) countEl.textContent = '共 ' + result.count + ' 条记录';
            } catch (error) {
                console.error('加载商户数据失败:', error);
                showToast('error', '加载失败', '无法获取商户数据');
            }
        }

        function renderOrders() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">订单管理</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-secondary" onclick="showToast(\'success\', \'导出成功\', \'订单数据已导出\')">' +
                '            <i class="ri-download-2-line"></i>' +
                '            导出订单' +
                '        </button>' +
                '    </div>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-body">' +
                '        <div class="filter-bar">' +
                '            <input type="text" class="form-input" placeholder="搜索订单号、商户订单号...">' +
                '            <select class="form-input form-select">' +
                '                <option value="">全部状态</option>' +
                '                <option value="0">未支付</option>' +
                '                <option value="1">已支付</option>' +
                '                <option value="2">已退款</option>' +
                '                <option value="3">已关闭</option>' +
                '            </select>' +
                '            <select class="form-input form-select">' +
                '                <option value="">全部支付方式</option>' +
                '                <option value="alipay">支付宝</option>' +
                '                <option value="wxpay">微信支付</option>' +
                '                <option value="qqpay">QQ钱包</option>' +
                '            </select>' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-search-line"></i>' +
                '                搜索' +
                '            </button>' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-refresh-line"></i>' +
                '                重置' +
                '            </button>' +
                '        </div>' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>订单号</th>' +
                '                        <th>商户订单号</th>' +
                '                        <th>商户</th>' +
                '                        <th>支付方式</th>' +
                '                        <th>金额</th>' +
                '                        <th>状态</th>' +
                '                        <th>创建时间</th>' +
                '                        <th>支付时间</th>' +
                '                        <th>操作</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody id="ordersTableBody">' +
                '                    <tr><td colspan="9" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info" id="ordersCount">共 0 条记录</div>' +
                '            <div class="pagination-buttons">' +
                '                <button class="pagination-btn" disabled>&lt;</button>' +
                '                <button class="pagination-btn active">1</button>' +
                '                <button class="pagination-btn">&gt;</button>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载订单数据
        async function loadOrdersData() {
            try {
                var result = await api.getOrders();
                var tbody = document.getElementById('ordersTableBody');
                var countEl = document.getElementById('ordersCount');
                
                if (!tbody) return;
                
                var html = '';
                result.data.forEach(function(order) {
                    html += '<tr>' +
                        '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">' + order.tradeNo + '</code></td>' +
                        '<td>' + order.outTradeNo + '</td>' +
                        '<td>' + order.merchant + '</td>' +
                        '<td><i class="' + getPaymentTypeIcon(order.paymentType) + '" style="margin-right: 4px;"></i>' + getPaymentTypeName(order.paymentType) + '</td>' +
                        '<td>' + formatMoney(order.amount) + '</td>' +
                        '<td>' + getStatusBadge(order.status, 'order') + '</td>' +
                        '<td>' + formatDate(order.createdAt) + '</td>' +
                        '<td>' + formatDate(order.paidAt) + '</td>' +
                        '<td>' +
                        '    <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'查看详情\', \'订单详情页面开发中\')">' +
                        '        <i class="ri-eye-line"></i>' +
                        '    </button>' +
                        '</td>' +
                        '</tr>';
                });
                
                tbody.innerHTML = html;
                if (countEl) countEl.textContent = '共 ' + result.data.length + ' 条记录';
            } catch (error) {
                console.error('加载订单数据失败:', error);
                showToast('error', '加载失败', '无法获取订单数据');
            }
        }

        function renderSettlements() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">结算管理</h1>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-body">' +
                '        <div class="filter-bar">' +
                '            <select class="form-input form-select">' +
                '                <option value="">全部状态</option>' +
                '                <option value="0">待处理</option>' +
                '                <option value="2">已批准</option>' +
                '                <option value="3">已拒绝</option>' +
                '            </select>' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-search-line"></i>' +
                '                筛选' +
                '            </button>' +
                '        </div>' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>结算ID</th>' +
                '                        <th>商户</th>' +
                '                        <th>结算金额</th>' +
                '                        <th>状态</th>' +
                '                        <th>银行信息</th>' +
                '                        <th>申请时间</th>' +
                '                        <th>处理时间</th>' +
                '                        <th>操作</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody id="settlementsTableBody">' +
                '                    <tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info" id="settlementsCount">共 0 条记录</div>' +
                '            <div class="pagination-buttons">' +
                '                <button class="pagination-btn" disabled>&lt;</button>' +
                '                <button class="pagination-btn active">1</button>' +
                '                <button class="pagination-btn">&gt;</button>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载结算数据
        async function loadSettlementsData() {
            try {
                var result = await api.getSettlements();
                var tbody = document.getElementById('settlementsTableBody');
                var countEl = document.getElementById('settlementsCount');
                
                if (!tbody) return;
                
                var html = '';
                result.data.forEach(function(settlement) {
                    var actionHtml = '-';
                    if (settlement.status === 0) {
                        actionHtml = '<div style="display: flex; gap: 8px;">' +
                            '<button class="btn btn-sm btn-primary" onclick="handleSettlement(\'' + settlement.id + '\', \'approve\')">批准</button>' +
                            '<button class="btn btn-sm btn-danger" onclick="handleSettlement(\'' + settlement.id + '\', \'reject\')">拒绝</button>' +
                            '</div>';
                    }
                    
                    html += '<tr>' +
                        '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">' + settlement.id + '</code></td>' +
                        '<td>' + settlement.merchant + '</td>' +
                        '<td>' + formatMoney(settlement.amount) + '</td>' +
                        '<td>' + getStatusBadge(settlement.status, 'settlement') + '</td>' +
                        '<td>' + settlement.bankInfo + '</td>' +
                        '<td>' + formatDate(settlement.createdAt) + '</td>' +
                        '<td>' + formatDate(settlement.processedAt) + '</td>' +
                        '<td>' + actionHtml + '</td>' +
                        '</tr>';
                });
                
                tbody.innerHTML = html;
                if (countEl) countEl.textContent = '共 ' + result.data.length + ' 条记录';
            } catch (error) {
                console.error('加载结算数据失败:', error);
                showToast('error', '加载失败', '无法获取结算数据');
            }
        }

        // 结算处理
        function handleSettlement(id, action) {
            var title = action === 'approve' ? '确认批准结算' : '确认拒绝结算';
            var message = action === 'approve' 
                ? '确定要批准这笔结算申请吗？批准后资金将转出。'
                : '确定要拒绝这笔结算申请吗？拒绝后资金将退回商户余额。';

            showConfirm(title, message, async function() {
                try {
                    var reason = action === 'reject' ? '管理员拒绝' : '';
                    var result = await api.processSettlement(id, action, reason);
                    if (result.success) {
                        showToast('success', '操作成功', result.message);
                        // 刷新页面数据
                        navigateTo('settlements');
                    } else {
                        showToast('error', '操作失败', result.message);
                    }
                } catch (error) {
                    showToast('error', '操作失败', '网络错误，请重试');
                }
            });
        }

        function renderPaymentTypes() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">支付方式</h1>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-body">' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>标识</th>' +
                '                        <th>显示名称</th>' +
                '                        <th>图标</th>' +
                '                        <th>状态</th>' +
                '                        <th>排序</th>' +
                '                        <th>操作</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody>' +
                '                    <tr>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">alipay</code></td>' +
                '                        <td>支付宝</td>' +
                '                        <td><i class="ri-alipay-line" style="font-size: 24px;"></i></td>' +
                '                        <td><span class="badge success">启用</span></td>' +
                '                        <td>1</td>' +
                '                        <td><button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'编辑\', \'支付方式编辑功能开发中\')"><i class="ri-edit-line"></i></button></td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">wxpay</code></td>' +
                '                        <td>微信支付</td>' +
                '                        <td><i class="ri-wechat-pay-line" style="font-size: 24px;"></i></td>' +
                '                        <td><span class="badge success">启用</span></td>' +
                '                        <td>2</td>' +
                '                        <td><button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'编辑\', \'支付方式编辑功能开发中\')"><i class="ri-edit-line"></i></button></td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">qqpay</code></td>' +
                '                        <td>QQ钱包</td>' +
                '                        <td><i class="ri-qq-line" style="font-size: 24px;"></i></td>' +
                '                        <td><span class="badge success">启用</span></td>' +
                '                        <td>3</td>' +
                '                        <td><button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'编辑\', \'支付方式编辑功能开发中\')"><i class="ri-edit-line"></i></button></td>' +
                '                    </tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        function renderChannels() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">支付通道</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-primary" onclick="showToast(\'info\', \'添加通道\', \'添加通道功能开发中\')">' +
                '            <i class="ri-add-line"></i>' +
                '            添加通道' +
                '        </button>' +
                '    </div>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-body">' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>通道ID</th>' +
                '                        <th>通道名称</th>' +
                '                        <th>支付方式</th>' +
                '                        <th>插件</th>' +
                '                        <th>费率</th>' +
                '                        <th>金额范围</th>' +
                '                        <th>状态</th>' +
                '                        <th>操作</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody>' +
                '                    <tr>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">ch_001</code></td>' +
                '                        <td>支付宝官方通道</td>' +
                '                        <td><i class="ri-alipay-line" style="margin-right: 4px;"></i>支付宝</td>' +
                '                        <td>alipay_official</td>' +
                '                        <td>0.60%</td>' +
                '                        <td>¥0.01 - ¥50,000.00</td>' +
                '                        <td><span class="badge success">启用</span></td>' +
                '                        <td>' +
                '                            <div style="display: flex; gap: 8px;">' +
                '                                <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'编辑\', \'通道编辑功能开发中\')"><i class="ri-edit-line"></i></button>' +
                '                                <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'配置\', \'通道配置功能开发中\')"><i class="ri-settings-3-line"></i></button>' +
                '                            </div>' +
                '                        </td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">ch_002</code></td>' +
                '                        <td>微信支付官方通道</td>' +
                '                        <td><i class="ri-wechat-pay-line" style="margin-right: 4px;"></i>微信支付</td>' +
                '                        <td>wxpay_official</td>' +
                '                        <td>0.60%</td>' +
                '                        <td>¥0.01 - ¥50,000.00</td>' +
                '                        <td><span class="badge success">启用</span></td>' +
                '                        <td>' +
                '                            <div style="display: flex; gap: 8px;">' +
                '                                <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'编辑\', \'通道编辑功能开发中\')"><i class="ri-edit-line"></i></button>' +
                '                                <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'配置\', \'通道配置功能开发中\')"><i class="ri-settings-3-line"></i></button>' +
                '                            </div>' +
                '                        </td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">ch_003</code></td>' +
                '                        <td>QQ钱包官方通道</td>' +
                '                        <td><i class="ri-qq-line" style="margin-right: 4px;"></i>QQ钱包</td>' +
                '                        <td>qqpay_official</td>' +
                '                        <td>0.60%</td>' +
                '                        <td>¥0.01 - ¥50,000.00</td>' +
                '                        <td><span class="badge success">启用</span></td>' +
                '                        <td>' +
                '                            <div style="display: flex; gap: 8px;">' +
                '                                <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'编辑\', \'通道编辑功能开发中\')"><i class="ri-edit-line"></i></button>' +
                '                                <button class="btn btn-sm btn-secondary" onclick="showToast(\'info\', \'配置\', \'通道配置功能开发中\')"><i class="ri-settings-3-line"></i></button>' +
                '                            </div>' +
                '                        </td>' +
                '                    </tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        function renderSettings() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">系统配置</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-primary" onclick="saveSettings()">' +
                '            <i class="ri-save-line"></i>' +
                '            保存配置' +
                '        </button>' +
                '    </div>' +
                '</div>' +
                '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;" class="fade-in">' +
                '    <div class="card">' +
                '        <div class="card-header">' +
                '            <span class="card-title">基本配置</span>' +
                '        </div>' +
                '        <div class="card-body">' +
                '            <div class="form-group">' +
                '                <label class="form-label">系统名称</label>' +
                '                <input type="text" class="form-input" id="config_site_name" value="Teaven Pay">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">系统URL</label>' +
                '                <input type="text" class="form-input" id="config_site_url" value="https://pay.example.com">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">默认货币</label>' +
                '                <select class="form-input form-select" id="config_currency">' +
                '                    <option value="CNY" selected>人民币 (CNY)</option>' +
                '                    <option value="USD">美元 (USD)</option>' +
                '                </select>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">系统语言</label>' +
                '                <select class="form-input form-select" id="config_language">' +
                '                    <option value="zh-CN" selected>简体中文</option>' +
                '                    <option value="en-US">English</option>' +
                '                </select>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '    <div class="card">' +
                '        <div class="card-header">' +
                '            <span class="card-title">支付配置</span>' +
                '        </div>' +
                '        <div class="card-body">' +
                '            <div class="form-group">' +
                '                <label class="form-label">订单超时时间 (分钟)</label>' +
                '                <input type="number" class="form-input" id="config_order_timeout" value="30">' +
                '                <div class="form-hint">未支付订单自动关闭时间</div>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">通知重试次数</label>' +
                '                <input type="number" class="form-input" id="config_notify_retry" value="5">' +
                '                <div class="form-hint">异步通知失败重试次数</div>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">通知重试间隔</label>' +
                '                <input type="text" class="form-input" id="config_notify_interval" value="1,5,30,60,360" readonly>' +
                '                <div class="form-hint">重试间隔(分钟)，用逗号分隔</div>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '    <div class="card">' +
                '        <div class="card-header">' +
                '            <span class="card-title">安全配置</span>' +
                '        </div>' +
                '        <div class="card-body">' +
                '            <div class="form-group">' +
                '                <label class="form-label">IP白名单</label>' +
                '                <textarea class="form-input form-textarea" id="config_ip_whitelist" placeholder="每行一个IP地址，留空表示不限制">192.168.1.0/24\\n10.0.0.0/8</textarea>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">请求频率限制</label>' +
                '                <input type="number" class="form-input" id="config_rate_limit" value="100">' +
                '                <div class="form-hint">每分钟最大请求数</div>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '    <div class="card">' +
                '        <div class="card-header">' +
                '            <span class="card-title">通知配置</span>' +
                '        </div>' +
                '        <div class="card-body">' +
                '            <div class="form-group">' +
                '                <label class="form-label">管理员邮箱</label>' +
                '                <input type="email" class="form-input" id="config_admin_email" value="admin@example.com">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">SMTP服务器</label>' +
                '                <input type="text" class="form-input" id="config_smtp_host" value="smtp.example.com">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">SMTP端口</label>' +
                '                <input type="number" class="form-input" id="config_smtp_port" value="465">' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 保存设置
        async function saveSettings() {
            try {
                var configData = {
                    site_name: document.getElementById('config_site_name').value,
                    site_url: document.getElementById('config_site_url').value,
                    currency: document.getElementById('config_currency').value,
                    language: document.getElementById('config_language').value,
                    order_timeout: document.getElementById('config_order_timeout').value,
                    notify_retry: document.getElementById('config_notify_retry').value,
                    notify_interval: document.getElementById('config_notify_interval').value,
                    ip_whitelist: document.getElementById('config_ip_whitelist').value,
                    rate_limit: document.getElementById('config_rate_limit').value,
                    admin_email: document.getElementById('config_admin_email').value,
                    smtp_host: document.getElementById('config_smtp_host').value,
                    smtp_port: document.getElementById('config_smtp_port').value
                };
                
                var result = await api.updateConfig(configData);
                if (result.success) {
                    showToast('success', '保存成功', '系统配置已更新');
                } else {
                    showToast('error', '保存失败', result.message);
                }
            } catch (error) {
                showToast('error', '保存失败', '网络错误，请重试');
            }
        }

        function renderLogs() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">操作日志</h1>' +
                '</div>' +
                '<div class="card fade-in">' +
                '    <div class="card-body">' +
                '        <div class="filter-bar">' +
                '            <input type="text" class="form-input" placeholder="搜索操作内容...">' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-search-line"></i>' +
                '                搜索' +
                '            </button>' +
                '            <button class="btn btn-secondary">' +
                '                <i class="ri-refresh-line"></i>' +
                '                重置' +
                '            </button>' +
                '        </div>' +
                '        <div class="table-container">' +
                '            <table class="data-table">' +
                '                <thead>' +
                '                    <tr>' +
                '                        <th>日志ID</th>' +
                '                        <th>操作用户</th>' +
                '                        <th>操作类型</th>' +
                '                        <th>操作详情</th>' +
                '                        <th>IP地址</th>' +
                '                        <th>操作时间</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody>' +
                '                    <tr>' +
                '                        <td>1</td>' +
                '                        <td>管理员</td>' +
                '                        <td><span class="badge info">登录系统</span></td>' +
                '                        <td>IP: 192.168.1.100</td>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">192.168.1.100</code></td>' +
                '                        <td>2026-06-23 09:00:00</td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td>2</td>' +
                '                        <td>管理员</td>' +
                '                        <td><span class="badge info">创建商户</span></td>' +
                '                        <td>商户ID: m_006, 用户名: 成都科技</td>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">192.168.1.100</code></td>' +
                '                        <td>2026-06-23 09:15:00</td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td>3</td>' +
                '                        <td>管理员</td>' +
                '                        <td><span class="badge info">审批结算</span></td>' +
                '                        <td>结算ID: s_002, 金额: 3000.00</td>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">192.168.1.100</code></td>' +
                '                        <td>2026-06-23 09:30:00</td>' +
                '                    </tr>' +
                '                    <tr>' +
                '                        <td>4</td>' +
                '                        <td>管理员</td>' +
                '                        <td><span class="badge info">更新配置</span></td>' +
                '                        <td>系统名称更新</td>' +
                '                        <td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">192.168.1.100</code></td>' +
                '                        <td>2026-06-23 10:00:00</td>' +
                '                    </tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info">共 4 条记录</div>' +
                '            <div class="pagination-buttons">' +
                '                <button class="pagination-btn" disabled>&lt;</button>' +
                '                <button class="pagination-btn active">1</button>' +
                '                <button class="pagination-btn">&gt;</button>' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 页面映射
        var pageRenderers = {
            dashboard: renderDashboard,
            merchants: renderMerchants,
            orders: renderOrders,
            settlements: renderSettlements,
            'payment-types': renderPaymentTypes,
            channels: renderChannels,
            settings: renderSettings,
            logs: renderLogs
        };

        // 页面数据加载器
        var pageDataLoaders = {
            dashboard: loadDashboardData,
            merchants: loadMerchantsData,
            orders: loadOrdersData,
            settlements: loadSettlementsData
        };

        // 导航到指定页面
        function navigateTo(page) {
            state.currentPage = page;

            // 更新导航激活状态
            document.querySelectorAll('.nav-item').forEach(function(item) {
                item.classList.remove('active');
                if (item.dataset.page === page) {
                    item.classList.add('active');
                }
            });

            // 更新面包屑
            var pageNames = {
                dashboard: '仪表盘',
                merchants: '商户管理',
                orders: '订单管理',
                settlements: '结算管理',
                'payment-types': '支付方式',
                channels: '支付通道',
                settings: '系统配置',
                logs: '操作日志'
            };
            document.getElementById('breadcrumbCurrent').textContent = pageNames[page] || page;

            // 渲染页面
            var renderer = pageRenderers[page];
            if (renderer) {
                document.getElementById('mainContent').innerHTML = renderer();
            }

            // 加载页面数据
            var dataLoader = pageDataLoaders[page];
            if (dataLoader) {
                dataLoader();
            }

            // 初始化图表
            if (page === 'dashboard') {
                setTimeout(function() {
                    try {
                        initCharts();
                    } catch (e) {
                        console.error('图表初始化失败:', e);
                    }
                }, 100);
            }

            // 移动端关闭侧边栏
            if (window.innerWidth <= 1024) {
                closeSidebar();
            }
        }

        // 初始化图表
        function initCharts() {
            // 交易趋势图
            var trendChartEl = document.getElementById('trendChart');
            if (trendChartEl) {
                window.trendChart = echarts.init(trendChartEl);
                var trendOption = {
                    tooltip: {
                        trigger: 'axis',
                        axisPointer: {
                            type: 'shadow'
                        }
                    },
                    grid: {
                        left: '3%',
                        right: '4%',
                        bottom: '3%',
                        containLabel: true
                    },
                    xAxis: {
                        type: 'category',
                        data: ['6月17日', '6月18日', '6月19日', '6月20日', '6月21日', '6月22日', '6月23日'],
                        axisLine: {
                            lineStyle: {
                                color: '#9ca3af'
                            }
                        },
                        axisLabel: {
                            color: '#6b7280'
                        }
                    },
                    yAxis: {
                        type: 'value',
                        axisLine: {
                            show: false
                        },
                        axisTick: {
                            show: false
                        },
                        axisLabel: {
                            color: '#6b7280',
                            formatter: '¥{value}'
                        },
                        splitLine: {
                            lineStyle: {
                                color: '#e5e7eb',
                                type: 'dashed'
                            }
                        }
                    },
                    series: [
                        {
                            name: '交易金额',
                            type: 'line',
                            smooth: true,
                            data: [45000, 52000, 48000, 61000, 58000, 72000, 89000],
                            itemStyle: {
                                color: '#f59e0b'
                            },
                            areaStyle: {
                                color: {
                                    type: 'linear',
                                    x: 0,
                                    y: 0,
                                    x2: 0,
                                    y2: 1,
                                    colorStops: [{
                                        offset: 0,
                                        color: 'rgba(245, 158, 11, 0.3)'
                                    }, {
                                        offset: 1,
                                        color: 'rgba(245, 158, 11, 0.05)'
                                    }]
                                }
                            }
                        }
                    ]
                };
                window.trendChart.setOption(trendOption);
            }

            // 支付方式分布图
            var paymentChartEl = document.getElementById('paymentChart');
            if (paymentChartEl) {
                window.paymentChart = echarts.init(paymentChartEl);
                var paymentOption = {
                    tooltip: {
                        trigger: 'item',
                        formatter: '{b}: {c} ({d}%)'
                    },
                    legend: {
                        orient: 'vertical',
                        right: '5%',
                        top: 'center',
                        textStyle: {
                            color: '#6b7280'
                        }
                    },
                    series: [
                        {
                            name: '支付方式',
                            type: 'pie',
                            radius: ['40%', '70%'],
                            center: ['40%', '50%'],
                            avoidLabelOverlap: false,
                            itemStyle: {
                                borderRadius: 6,
                                borderColor: '#fff',
                                borderWidth: 2
                            },
                            label: {
                                show: false,
                                position: 'center'
                            },
                            emphasis: {
                                label: {
                                    show: true,
                                    fontSize: '14',
                                    fontWeight: 'bold'
                                }
                            },
                            labelLine: {
                                show: false
                            },
                            data: [
                                { value: 58000, name: '支付宝', itemStyle: { color: '#3b82f6' } },
                                { value: 35000, name: '微信支付', itemStyle: { color: '#10b981' } },
                                { value: 12000, name: 'QQ钱包', itemStyle: { color: '#8b5cf6' } }
                            ]
                        }
                    ]
                };
                window.paymentChart.setOption(paymentOption);
            }

            // 每小时订单柱状图
            var hourlyChartEl = document.getElementById('hourlyChart');
            if (hourlyChartEl) {
                window.hourlyChart = echarts.init(hourlyChartEl);
                var hourlyOption = {
                    tooltip: {
                        trigger: 'axis',
                        axisPointer: {
                            type: 'shadow'
                        },
                        formatter: function(params) {
                            return params[0].name + '<br/>' +
                                   params[0].seriesName + ': ' + params[0].value + ' 单';
                        }
                    },
                    grid: {
                        left: '3%',
                        right: '4%',
                        bottom: '3%',
                        containLabel: true
                    },
                    xAxis: {
                        type: 'category',
                        data: ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'],
                        axisLine: {
                            lineStyle: {
                                color: '#9ca3af'
                            }
                        },
                        axisLabel: {
                            color: '#6b7280'
                        }
                    },
                    yAxis: {
                        type: 'value',
                        axisLine: {
                            show: false
                        },
                        axisTick: {
                            show: false
                        },
                        axisLabel: {
                            color: '#6b7280'
                        },
                        splitLine: {
                            lineStyle: {
                                color: '#e5e7eb',
                                type: 'dashed'
                            }
                        }
                    },
                    series: [
                        {
                            name: '订单数',
                            type: 'bar',
                            barWidth: '60%',
                            data: [12, 8, 5, 15, 45, 78, 95, 120, 110, 85, 65, 30],
                            itemStyle: {
                                color: {
                                    type: 'linear',
                                    x: 0,
                                    y: 0,
                                    x2: 0,
                                    y2: 1,
                                    colorStops: [{
                                        offset: 0,
                                        color: '#f59e0b'
                                    }, {
                                        offset: 1,
                                        color: '#fbbf24'
                                    }]
                                },
                                borderRadius: [4, 4, 0, 0]
                            }
                        }
                    ]
                };
                window.hourlyChart.setOption(hourlyOption);
            }

            // 响应式调整
            window.addEventListener('resize', function() {
                if (window.trendChart) window.trendChart.resize();
                if (window.paymentChart) window.paymentChart.resize();
                if (window.hourlyChart) window.hourlyChart.resize();
            });
        }

        // 显示模态框
        function showModal(type) {
            if (type === 'createMerchant') {
                var modalHTML = '<div class="modal-overlay" id="modalOverlay">' +
                    '<div class="modal">' +
                    '    <div class="modal-header">' +
                    '        <span class="modal-title">创建商户</span>' +
                    '        <button class="modal-close" onclick="closeModal()">' +
                    '            <i class="ri-close-line"></i>' +
                    '        </button>' +
                    '    </div>' +
                    '    <div class="modal-body">' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">用户名 <span style="color: var(--error);">*</span></label>' +
                    '            <input type="text" class="form-input" id="merchantUsername" placeholder="请输入用户名">' +
                    '            <div class="form-hint">商户登录用户名，需唯一</div>' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">邮箱</label>' +
                    '            <input type="email" class="form-input" id="merchantEmail" placeholder="请输入邮箱">' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">密码 <span style="color: var(--error);">*</span></label>' +
                    '            <input type="password" class="form-input" id="merchantPassword" placeholder="请输入密码">' +
                    '            <div class="form-hint">密码长度至少8位</div>' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">确认密码 <span style="color: var(--error);">*</span></label>' +
                    '            <input type="password" class="form-input" id="merchantConfirmPassword" placeholder="请再次输入密码">' +
                    '        </div>' +
                    '    </div>' +
                    '    <div class="modal-footer">' +
                    '        <button class="btn btn-secondary" onclick="closeModal()">取消</button>' +
                    '        <button class="btn btn-primary" onclick="submitMerchant()">创建</button>' +
                    '    </div>' +
                    '</div>' +
                    '</div>';

                document.body.insertAdjacentHTML('beforeend', modalHTML);
                setTimeout(function() {
                    document.getElementById('modalOverlay').classList.add('active');
                }, 10);
            }
        }

        // 关闭模态框
        function closeModal() {
            var overlay = document.getElementById('modalOverlay');
            if (overlay) {
                overlay.classList.remove('active');
                setTimeout(function() { overlay.remove(); }, 300);
            }
        }

        // 提交商户表单
        async function submitMerchant() {
            var username = document.getElementById('merchantUsername').value;
            var email = document.getElementById('merchantEmail').value;
            var password = document.getElementById('merchantPassword').value;
            var confirmPassword = document.getElementById('merchantConfirmPassword').value;

            // 表单验证
            if (!username) {
                showToast('error', '验证失败', '用户名不能为空');
                return;
            }
            if (!password) {
                showToast('error', '验证失败', '密码不能为空');
                return;
            }
            if (password.length < 8) {
                showToast('error', '验证失败', '密码长度至少8位');
                return;
            }
            if (password !== confirmPassword) {
                showToast('error', '验证失败', '两次密码输入不一致');
                return;
            }

            // 调用API创建商户
            try {
                var result = await api.createMerchant({
                    username: username,
                    email: email,
                    password: password
                });
                
                if (result.success) {
                    showToast('success', '创建成功', '商户 ' + username + ' 已成功创建');
                    closeModal();
                    // 刷新商户列表
                    if (state.currentPage === 'merchants') {
                        loadMerchantsData();
                    }
                } else {
                    showToast('error', '创建失败', result.message);
                }
            } catch (error) {
                showToast('error', '创建失败', '网络错误，请重试');
            }
        }

        // 侧边栏切换
        function toggleSidebar() {
            var sidebar = document.getElementById('sidebar');
            state.sidebarCollapsed = !state.sidebarCollapsed;
            sidebar.classList.toggle('collapsed');
        }

        // 移动端侧边栏
        function openSidebar() {
            var sidebar = document.getElementById('sidebar');
            var overlay = document.getElementById('drawerOverlay');
            sidebar.classList.add('mobile-open');
            overlay.classList.add('active');
        }

        function closeSidebar() {
            var sidebar = document.getElementById('sidebar');
            var overlay = document.getElementById('drawerOverlay');
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
        }

        // 主题切换
        function toggleTheme() {
            var html = document.documentElement;
            var currentTheme = html.getAttribute('data-theme');
            var newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            state.theme = newTheme;
            localStorage.setItem('theme', newTheme);

            // 更新图标
            var icon = document.querySelector('#themeToggle i');
            icon.className = newTheme === 'dark' ? 'ri-sun-line' : 'ri-moon-line';
        }

        // 初始化主题
        function initTheme() {
            var savedTheme = localStorage.getItem('theme');
            var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            var theme = savedTheme || (prefersDark ? 'dark' : 'light');
            document.documentElement.setAttribute('data-theme', theme);
            state.theme = theme;

            var icon = document.querySelector('#themeToggle i');
            icon.className = theme === 'dark' ? 'ri-sun-line' : 'ri-moon-line';
        }

        // 初始化
        document.addEventListener('DOMContentLoaded', function() {
            // 初始化主题
            initTheme();

            // 侧边栏切换按钮
            document.getElementById('sidebarToggle').addEventListener('click', function() {
                if (window.innerWidth <= 1024) {
                    openSidebar();
                } else {
                    toggleSidebar();
                }
            });

            // 遮罩层点击
            document.getElementById('drawerOverlay').addEventListener('click', closeSidebar);

            // 主题切换
            document.getElementById('themeToggle').addEventListener('click', toggleTheme);

            // 导航点击
            document.querySelectorAll('.nav-item[data-page]').forEach(function(item) {
                item.addEventListener('click', function(e) {
                    e.preventDefault();
                    navigateTo(this.dataset.page);
                });
            });

            // 渲染默认页面
            navigateTo('dashboard');

            // 监听系统主题变化
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                if (!localStorage.getItem('theme')) {
                    var theme = e.matches ? 'dark' : 'light';
                    document.documentElement.setAttribute('data-theme', theme);
                    state.theme = theme;
                    var icon = document.querySelector('#themeToggle i');
                    icon.className = theme === 'dark' ? 'ri-sun-line' : 'ri-moon-line';
                }
            });

            // 窗口大小变化处理
            window.addEventListener('resize', function() {
                if (window.innerWidth > 1024) {
                    closeSidebar();
                }
            });
        });
    </script>
</body>
</html>`);
});

// 404 处理
app.notFound((c) => {
    return c.json({ code: -4, msg: 'Not Found' }, 404);
});

// 导出
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        return app.fetch(request, env, ctx);
    },
    
    // 定时任务 (可选)
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        // TODO: 实现定时任务
        // 1. 清理过期订单
        // 2. 重试异步通知
        // 3. 统计数据
        console.log('Scheduled event triggered:', event.cron);
    },
};
