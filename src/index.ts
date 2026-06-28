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
import { apiKeyRouter } from './routes/api-key';

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
app.use('*', async (c, next) => {
    const allowedOrigins = (c.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const corsMiddleware = cors({
        origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        exposeHeaders: ['X-Request-Id'],
        maxAge: 86400,
        credentials: allowedOrigins.length > 0,
    });
    return corsMiddleware(c, next);
});

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

// API 路由
app.route('/api/pay', payRouter);
app.route('/api/merchant', merchantRouter);
app.route('/api/merchant/api-keys', apiKeyRouter);
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

// 公开收银台页面
app.get('/pay/:merchantId', async (c) => {
    const { merchantId } = c.req.param();
    const env = c.env;

    try {
        const user = await env.DB.prepare(
            'SELECT id, username, status FROM users WHERE id = ? AND role = ?'
        ).bind(merchantId, 'merchant').first();

        if (!user || user.status !== 1) {
            return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>收银台</title></head><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;color:#6b7280;"><div style="text-align:center;"><h2>商户不存在或已停用</h2></div></body></html>`);
        }

        const channels = await env.DB.prepare(
            `SELECT pt.id, pt.name, pt.display_name, pt.icon FROM payment_types pt
             INNER JOIN channels c ON c.payment_type_id = pt.id AND c.status = 1
             GROUP BY pt.id ORDER BY pt.sort_order`
        ).all();

        const payTypes = (channels.results || []).map((ch: any) => ({ id: ch.id, name: ch.display_name, icon: ch.icon || '' }));

        return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>收银台 - ${user.username || 'Teaven Pay'}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/remixicon@4.9.1/fonts/remixicon.css">
    <style>
        :root{--primary:#f59e0b;--primary-hover:#d97706;--bg:#f9fafb;--card:#fff;--border:#e5e7eb;--text:#111827;--text2:#4b5563;--text3:#9ca3af;--success:#10b981;--error:#ef4444;--radius:12px;}
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
        .cashier{width:100%;max-width:420px;}
        .cashier-header{text-align:center;margin-bottom:24px;}
        .cashier-header h1{font-size:20px;font-weight:700;color:var(--primary);}
        .cashier-header p{font-size:13px;color:var(--text3);margin-top:4px;}
        .cashier-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.07);}
        .form-group{margin-bottom:20px;}
        .form-label{display:block;font-size:13px;font-weight:600;color:var(--text2);margin-bottom:8px;}
        .amount-input{position:relative;}
        .amount-prefix{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:20px;font-weight:700;color:var(--text);}
        .amount-input input{width:100%;padding:14px 14px 14px 36px;border:2px solid var(--border);border-radius:10px;font-size:24px;font-weight:700;outline:none;transition:border-color .2s;}
        .amount-input input:focus{border-color:var(--primary);}
        .amount-input input::placeholder{color:var(--text3);font-weight:400;font-size:16px;}
        .pay-types{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;}
        .pay-type{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 10px;border:2px solid var(--border);border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;transition:all .2s;user-select:none;}
        .pay-type:hover{border-color:var(--primary);background:#fffbeb;}
        .pay-type.selected{border-color:var(--primary);background:#fffbeb;color:var(--primary-hover);}
        .pay-type i{font-size:20px;}
        .submit-btn{width:100%;padding:14px;background:var(--primary);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:background .2s;margin-top:8px;}
        .submit-btn:hover{background:var(--primary-hover);}
        .submit-btn:disabled{background:#d1d5db;cursor:not-allowed;}
        .error-msg{background:#fee2e2;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none;}
        .cashier-footer{text-align:center;margin-top:16px;font-size:12px;color:var(--text3);}
    </style>
</head>
<body>
    <div class="cashier">
        <div class="cashier-header">
            <h1><i class="ri-wallet-3-line"></i> 在线收银台</h1>
            <p>${user.username || 'Teaven Pay'}</p>
        </div>
        <div class="cashier-card">
            <div class="error-msg" id="errorMsg"></div>
            <div class="form-group">
                <label class="form-label">付款金额（元）</label>
                <div class="amount-input">
                    <span class="amount-prefix">\u00A5</span>
                    <input type="number" id="amount" placeholder="0.00" min="0.01" step="0.01" autofocus>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">选择支付方式</label>
                <div class="pay-types" id="payTypes"></div>
            </div>
            <button class="submit-btn" id="submitBtn" onclick="submitPay()">立即支付</button>
        </div>
        <div class="cashier-footer">Powered by Teaven Pay</div>
    </div>
    <script>
        var payTypes = ${JSON.stringify(payTypes)};
        var selectedType = '';
        var merchantId = '${merchantId}';
        var payTypesEl = document.getElementById('payTypes');

        var iconMap = {alipay:'ri-alipay-line',wxpay:'ri-wechat-pay-line',qqpay:'ri-qq-line'};

        if (payTypes.length === 0) {
            payTypesEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text3);padding:20px;">暂无可用支付方式</div>';
        } else {
            payTypes.forEach(function(pt, i) {
                var icon = iconMap[pt.id] || 'ri-bank-card-line';
                var div = document.createElement('div');
                div.className = 'pay-type';
                div.setAttribute('data-id', pt.id);
                div.innerHTML = '<i class="' + icon + '"></i><span>' + pt.name + '</span>';
                div.onclick = function() {
                    document.querySelectorAll('.pay-type').forEach(function(el){el.classList.remove('selected');});
                    div.classList.add('selected');
                    selectedType = pt.id;
                };
                payTypesEl.appendChild(div);
                if (i === 0) { div.classList.add('selected'); selectedType = pt.id; }
            });
        }

        function showError(msg) {
            var el = document.getElementById('errorMsg');
            el.textContent = msg;
            el.style.display = 'block';
        }

        async function submitPay() {
            var amountEl = document.getElementById('amount');
            var amount = parseFloat(amountEl.value);
            var errEl = document.getElementById('errorMsg');
            errEl.style.display = 'none';

            if (!amount || amount <= 0) { showError('请输入有效的付款金额'); return; }
            if (amount < 0.01) { showError('金额不能小于0.01元'); return; }
            if (!selectedType) { showError('请选择支付方式'); return; }

            var btn = document.getElementById('submitBtn');
            btn.disabled = true;
            btn.textContent = '正在创建订单...';

            try {
                var body = new URLSearchParams();
                body.set('merchant_id', merchantId);
                body.set('amount', amount.toFixed(2));
                body.set('type', selectedType);
                body.set('name', '在线收银台付款');

                var res = await fetch('/api/pay/cashier', { method: 'POST', body: body });
                var data = await res.json();

                if (data.code === 1) {
                    if (data.payurl) {
                        window.location.href = data.payurl;
                    } else if (data.qrcode) {
                        window.location.href = '/cashier/' + data.trade_no;
                    }
                } else {
                    showError(data.msg || '创建订单失败');
                }
            } catch (e) {
                showError('网络错误，请重试');
            }

            btn.disabled = false;
            btn.textContent = '立即支付';
        }
    </script>
</body>
</html>`);
    } catch (error) {
        console.error('Cashier page error:', error);
        return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>系统错误</body></html>`, 500);
    }
});

// 管理后台页面（同时匹配 /admin 和 /admin/）
app.get('/admin', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Teaven Pay - 管理后台</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/remixicon@4.9.1/fonts/remixicon.css">
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

        /* 开关 */
        .toggle-switch {
            position: relative;
            display: inline-block;
            width: 44px;
            height: 24px;
            cursor: pointer;
        }

        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--bg-tertiary);
            border-radius: 24px;
            transition: all 0.3s ease;
        }

        .toggle-slider:before {
            content: "";
            position: absolute;
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            border-radius: 50%;
            transition: all 0.3s ease;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .toggle-switch input:checked + .toggle-slider {
            background-color: var(--primary-500);
        }

        .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(20px);
        }

        .toggle-switch input:focus + .toggle-slider {
            box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.2);
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
                    </a>
                    <a href="#" class="nav-item" data-page="orders">
                        <i class="ri-file-list-3-line"></i>
                        <span>订单管理</span>
                    </a>
                    <a href="#" class="nav-item" data-page="settlements">
                        <i class="ri-money-cny-circle-line"></i>
                        <span>结算管理</span>
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
                            <div class="user-avatar" id="userAvatar">管</div>
                            <span id="userDisplayName">管理员</span>
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
                            <a href="#" class="dropdown-item" data-action="logout" onclick="handleLogout()">
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
            logs: [],
            currentMerchant: null,
            token: localStorage.getItem('admin_token') || null,
            user: JSON.parse(localStorage.getItem('admin_user') || 'null')
        };

        // Token 管理
        function getToken() {
            return state.token;
        }

        function setAuth(token, user) {
            state.token = token;
            state.user = user;
            localStorage.setItem('admin_token', token);
            localStorage.setItem('admin_user', JSON.stringify(user));
        }

        function clearAuth() {
            state.token = null;
            state.user = null;
            localStorage.removeItem('admin_token');
            localStorage.removeItem('admin_user');
        }

        function isLoggedIn() {
            return !!state.token;
        }

        // 登录页面
        function renderLogin() {
            return '<div style="min-height: 100vh; width: 100%; display: flex; align-items: center; justify-content: center; background: var(--bg-secondary); padding: 20px;">' +
                '<div class="card fade-in" style="width: 100%; max-width: 420px; margin: auto;">' +
                '    <div class="card-body" style="padding: 40px;">' +
                '        <div style="text-align: center; margin-bottom: 32px;">' +
                '            <div style="width: 64px; height: 64px; margin: 0 auto 16px; background: var(--primary-50); border-radius: 16px; display: flex; align-items: center; justify-content: center;">' +
                '                <i class="ri-bank-card-line" style="font-size: 32px; color: var(--primary-500);"></i>' +
                '            </div>' +
                '            <h1 style="font-size: 24px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px;">Teaven Pay</h1>' +
                '            <p style="font-size: 14px; color: var(--text-secondary);">管理后台登录</p>' +
                '        </div>' +
                '        <form id="loginForm" onsubmit="handleLogin(event)">' +
                '            <div class="form-group">' +
                '                <label class="form-label">用户名</label>' +
                '                <input type="text" class="form-input" id="loginUsername" placeholder="请输入管理员用户名" required>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">密码</label>' +
                '                <input type="password" class="form-input" id="loginPassword" placeholder="请输入密码" required>' +
                '            </div>' +
                '            <div id="loginError" style="display: none; color: var(--error); font-size: 13px; margin-bottom: 12px;"></div>' +
                '            <button type="submit" class="btn btn-primary btn-lg" style="width: 100%; margin-top: 8px;" id="loginBtn">登录</button>' +
                '        </form>' +
                '    </div>' +
                '</div>' +
                '</div>';
        }

        // 处理登录
        async function handleLogin(event) {
            event.preventDefault();
            var username = document.getElementById('loginUsername').value;
            var password = document.getElementById('loginPassword').value;
            var errorEl = document.getElementById('loginError');
            var btnEl = document.getElementById('loginBtn');

            errorEl.style.display = 'none';
            btnEl.disabled = true;
            btnEl.textContent = '登录中...';

            try {
                var response = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ username, password })
                });
                var data = await response.json();

                if (data.code === 0) {
                    setAuth(data.data.token, data.data.user);
                    // 重新加载页面以恢复完整布局
                    window.location.reload();
                } else {
                    errorEl.textContent = data.msg || '登录失败';
                    errorEl.style.display = 'block';
                }
            } catch (error) {
                errorEl.textContent = '网络错误，请重试';
                errorEl.style.display = 'block';
            } finally {
                btnEl.disabled = false;
                btnEl.textContent = '登录';
            }
        }

        // 退出登录
        function handleLogout() {
            clearAuth();
            navigateTo('login');
        }

        // API 服务
        const api = {
            // 通用请求方法
            async request(url, options = {}) {
                const token = getToken();
                const headers = options.headers || {};
                if (token) {
                    headers['Authorization'] = 'Bearer ' + token;
                }
                const response = await fetch(url, { ...options, headers });
                // HTTP 401 直接判定为登录失效
                if (response.status === 401) {
                    clearAuth();
                    navigateTo('login');
                    throw new Error('登录已过期，请重新登录');
                }
                // 兼容后端业务码：code === -2 表示未授权/Token 失效/权限不足
                // 管理后台中此类情况一律回到登录页
                if (response.status === 403 || response.status === 200) {
                    let bizCode = null;
                    try {
                        const clone = response.clone();
                        const data = await clone.json();
                        bizCode = data && typeof data.code !== 'undefined' ? data.code : null;
                    } catch (e) {
                        // 非 JSON 响应，忽略
                    }
                    if (bizCode === -2) {
                        clearAuth();
                        navigateTo('login');
                        throw new Error('登录已失效，请重新登录');
                    }
                }
                return response;
            },

            // 获取统计数据
            async getStats() {
                try {
                    const response = await this.request('/api/admin/stats');
                    const data = await response.json();
                    if (data.code === 1) {
                        return data.data;
                    }
                    throw new Error(data.msg || '获取统计数据失败');
                } catch (error) {
                    console.error('获取统计数据失败:', error);
                    throw error;
                }
            },

            // 获取商户列表
            async getMerchants(params = {}) {
                try {
                    const queryString = new URLSearchParams(params).toString();
                    const response = await this.request('/api/admin/merchants?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { count: data.count, data: data.data };
                    }
                    throw new Error(data.msg || '获取商户列表失败');
                } catch (error) {
                    console.error('获取商户列表失败:', error);
                    throw error;
                }
            },

            // 获取商户详情
            async getMerchantDetail(id) {
                try {
                    const response = await this.request('/api/admin/merchants/' + id);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true, data: data.data };
                    }
                    throw new Error(data.msg || '获取商户详情失败');
                } catch (error) {
                    console.error('获取商户详情失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 更新商户信息
            async updateMerchant(id, merchantData) {
                try {
                    const response = await this.request('/api/admin/merchants/' + id, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams(merchantData)
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true, message: data.msg };
                    }
                    throw new Error(data.msg || '更新商户信息失败');
                } catch (error) {
                    console.error('更新商户信息失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 创建商户
            async createMerchant(merchantData) {
                try {
                    const response = await this.request('/api/admin/merchants', {
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
                    const response = await this.request('/api/admin/merchants/' + id + '/status', {
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

            // 生成商户用户中心登录 Token
            async getMerchantLoginToken(id) {
                try {
                    const response = await this.request('/api/admin/merchants/' + id + '/login-token', {
                        method: 'POST'
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true, data: data.data };
                    }
                    throw new Error(data.msg || '生成登录链接失败');
                } catch (error) {
                    console.error('生成商户登录链接失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 获取订单列表
            async getOrders(params = {}) {
                try {
                    const queryString = new URLSearchParams(params).toString();
                    const response = await this.request('/api/admin/orders?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取订单列表失败');
                } catch (error) {
                    console.error('获取订单列表失败:', error);
                    throw error;
                }
            },

            // 获取结算列表
            async getSettlements(params = {}) {
                try {
                    const queryString = new URLSearchParams(params).toString();
                    const response = await this.request('/api/admin/settlements?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取结算列表失败');
                } catch (error) {
                    console.error('获取结算列表失败:', error);
                    throw error;
                }
            },

            // 处理结算
            async processSettlement(id, action, reason) {
                try {
                    const response = await this.request('/api/admin/settlements/' + id, {
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
                    const response = await this.request('/api/admin/config');
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
                    const response = await this.request('/api/admin/config', {
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
            },

            // 获取支付方式列表
            async getPaymentTypes() {
                try {
                    const response = await this.request('/api/admin/payment-types');
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取支付方式失败');
                } catch (error) {
                    console.error('获取支付方式失败:', error);
                    return { data: [] };
                }
            },

            // 获取可用插件列表
            async getPlugins() {
                try {
                    const response = await this.request('/api/admin/plugins');
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取插件列表失败');
                } catch (error) {
                    console.error('获取插件列表失败:', error);
                    return { data: [] };
                }
            },

            // 更新支付方式
            async updatePaymentType(id, paymentTypeData) {
                try {
                    const response = await this.request('/api/admin/payment-types/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(paymentTypeData)
                    });
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '更新支付方式失败');
                } catch (error) {
                    console.error('更新支付方式失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 切换支付方式状态
            async togglePaymentTypeStatus(id, status) {
                try {
                    const response = await this.request('/api/admin/payment-types/' + id + '/status', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status })
                    });
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '切换状态失败');
                } catch (error) {
                    console.error('切换状态失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 获取支付通道列表
            async getChannels() {
                try {
                    const response = await this.request('/api/admin/channels');
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取支付通道失败');
                } catch (error) {
                    console.error('获取支付通道失败:', error);
                    return { data: [] };
                }
            },

            // 创建通道
            async createChannel(channelData) {
                try {
                    const response = await this.request('/api/admin/channels', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(channelData)
                    });
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true, data: data.data };
                    }
                    throw new Error(data.msg || '创建通道失败');
                } catch (error) {
                    console.error('创建通道失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 更新通道
            async updateChannel(id, channelData) {
                try {
                    const response = await this.request('/api/admin/channels/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(channelData)
                    });
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '更新通道失败');
                } catch (error) {
                    console.error('更新通道失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 删除通道
            async deleteChannel(id) {
                try {
                    const response = await this.request('/api/admin/channels/' + id, {
                        method: 'DELETE'
                    });
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '删除通道失败');
                } catch (error) {
                    console.error('删除通道失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 切换通道状态
            async toggleChannelStatus(id, status) {
                try {
                    const response = await this.request('/api/admin/channels/' + id + '/status', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status })
                    });
                    const data = await response.json();
                    if (data.code === 1) {
                        return { success: true };
                    }
                    throw new Error(data.msg || '切换状态失败');
                } catch (error) {
                    console.error('切换状态失败:', error);
                    return { success: false, message: error.message };
                }
            },

            // 获取操作日志列表
            async getLogs(params = {}) {
                try {
                    var queryString = new URLSearchParams(params).toString();
                    const response = await this.request('/api/admin/logs?' + queryString);
                    const data = await response.json();
                    if (data.code === 1) {
                        return { data: data.data };
                    }
                    throw new Error(data.msg || '获取操作日志失败');
                } catch (error) {
                    console.error('获取操作日志失败:', error);
                    return { data: [] };
                }
            }
        };

        // 工具函数
        function formatMoney(amount) {
            if (typeof amount !== 'number' || isNaN(amount)) return '¥0.00';
            return '¥' + amount.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
        }

        function formatDate(dateStr) {
            if (!dateStr) return '-';
            return dateStr;
        }

        function escapeHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
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
                '        <div class="stat-change"><span id="todayOrdersChange">-</span></div>' +
                '    </div>' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">今日金额</span>' +
                '            <div class="stat-icon blue">' +
                '                <i class="ri-money-cny-circle-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="todayAmount">' + todayAmount + '</div>' +
                '        <div class="stat-change"><span id="todayAmountChange">-</span></div>' +
                '    </div>' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">今日利润</span>' +
                '            <div class="stat-icon yellow">' +
                '                <i class="ri-line-chart-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="todayProfit">' + todayProfit + '</div>' +
                '        <div class="stat-change"><span id="todayProfitChange">-</span></div>' +
                '    </div>' +
                '    <div class="stat-card">' +
                '        <div class="stat-header">' +
                '            <span class="stat-label">活跃商户</span>' +
                '            <div class="stat-icon purple">' +
                '                <i class="ri-store-2-line"></i>' +
                '            </div>' +
                '        </div>' +
                '        <div class="stat-value" id="activeMerchants">' + activeMerchants + '</div>' +
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
                '        <a href="#" class="btn btn-sm btn-secondary" onclick="event.preventDefault(); navigateTo(\\'orders\\')">查看全部</a>' +
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
                '                <tbody id="recentOrdersBody">' +
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
                
                if (todayOrdersEl) todayOrdersEl.textContent = (stats.today.orders || 0).toLocaleString();
                if (todayAmountEl) todayAmountEl.textContent = formatMoney(stats.today.amount || 0);
                if (todayProfitEl) todayProfitEl.textContent = formatMoney(stats.today.profit || 0);
                if (activeMerchantsEl) activeMerchantsEl.textContent = (stats.merchants.active || 0).toLocaleString();

                // 更新交易趋势图
                if (window.trendChart && stats.trend) {
                    window.trendChart.setOption({
                        xAxis: { data: stats.trend.dates || [] },
                        series: [{ name: '交易金额', data: stats.trend.amounts || [] }]
                    });
                }

                // 更新支付方式分布图
                if (window.paymentChart && stats.paymentDistribution) {
                    var colorPalette = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444'];
                    var pieData = (stats.paymentDistribution || []).map(function(item, idx) {
                        return {
                            value: item.value,
                            name: item.name,
                            itemStyle: { color: colorPalette[idx % colorPalette.length] }
                        };
                    });
                    if (pieData.length === 0) {
                        pieData = [{ value: 0, name: '暂无数据', itemStyle: { color: '#d1d5db' } }];
                    }
                    window.paymentChart.setOption({
                        series: [{ name: '支付方式', data: pieData }]
                    });
                }

                // 更新每小时订单柱状图
                if (window.hourlyChart && stats.hourly) {
                    window.hourlyChart.setOption({
                        series: [{ name: '订单数', data: stats.hourly.orders || [] }]
                    });
                    if (stats.hourly.hours) {
                        window.hourlyChart.setOption({
                            xAxis: { data: stats.hourly.hours }
                        });
                    }
                }

                // 加载最近订单
                try {
                    var ordersResult = await api.getOrders({ limit: 5 });
                    var recentBody = document.getElementById('recentOrdersBody');
                    if (recentBody) {
                        var recentOrders = ordersResult.data || [];
                        if (recentOrders.length === 0) {
                            recentBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-tertiary);">暂无订单数据</td></tr>';
                        } else {
                            var html = '';
                            recentOrders.forEach(function(order) {
                                html += '<tr>' +
                                    '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">' + (order.tradeNo || '') + '</code></td>' +
                                    '<td>' + (order.merchant || '-') + '</td>' +
                                    '<td><i class="' + getPaymentTypeIcon(order.paymentType) + '" style="margin-right: 4px;"></i>' + getPaymentTypeName(order.paymentType) + '</td>' +
                                    '<td>' + formatMoney(order.amount || 0) + '</td>' +
                                    '<td>' + getStatusBadge(order.status, 'order') + '</td>' +
                                    '<td>' + formatDate(order.createdAt) + '</td>' +
                                    '</tr>';
                            });
                            recentBody.innerHTML = html;
                        }
                    }
                } catch (e) {
                    console.error('加载最近订单失败:', e);
                }
            } catch (error) {
                console.error('加载仪表盘数据失败:', error);
                showToast('error', '加载失败', '无法获取仪表盘数据');
            }
        }

        function renderMerchants() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">商户管理</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-primary" onclick="showModal(\\'createMerchant\\')">' +
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
                        '        <button class="btn btn-sm btn-secondary" onclick="navigateToMerchantDetail(\\'' + merchant.id + '\\')" title="查看详情">' +
                        '            <i class="ri-eye-line"></i>' +
                        '        </button>' +
                        '        <button class="btn btn-sm btn-primary" onclick="loginAsMerchant(\\'' + merchant.id + '\\')" title="一键登录用户中心">' +
                        '            <i class="ri-login-box-line"></i>' +
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

        function renderMerchantDetail(merchant) {
            state.currentMerchant = merchant;

            var recentOrders = merchant.recentOrders || [];
            var recentSettlements = merchant.recentSettlements || [];
            var statusButton = merchant.status === 1
                ? '<button class="btn btn-danger" onclick="handleMerchantStatus(\\'' + merchant.id + '\\', 0)"><i class="ri-forbid-line"></i>禁用</button>'
                : '<button class="btn btn-primary" onclick="handleMerchantStatus(\\'' + merchant.id + '\\', 1)"><i class="ri-checkbox-circle-line"></i>启用</button>';

            var ordersHtml = recentOrders.length > 0 ? recentOrders.map(function(order) {
                return '<tr>' +
                    '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 12px;">' + escapeHtml(order.order_no || order.id || '') + '</code></td>' +
                    '<td>' + formatMoney(order.amount || 0) + '</td>' +
                    '<td>' + getStatusBadge(order.status, 'order') + '</td>' +
                    '<td style="font-size: 12px;">' + formatDate(order.created_at) + '</td>' +
                    '</tr>';
            }).join('') : '<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary); padding: 24px;">暂无订单</td></tr>';

            var settlementsHtml = recentSettlements.length > 0 ? recentSettlements.map(function(settle) {
                var settleId = settle.id || '';
                return '<tr>' +
                    '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 12px;">' + escapeHtml(settleId ? settleId.substring(0, 8) + '...' : '-') + '</code></td>' +
                    '<td>' + formatMoney(settle.amount || 0) + '</td>' +
                    '<td>' + getStatusBadge(settle.status, 'settlement') + '</td>' +
                    '<td style="font-size: 12px;">' + formatDate(settle.created_at) + '</td>' +
                    '</tr>';
            }).join('') : '<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary); padding: 24px;">暂无结算</td></tr>';

            return '<div class="page-header">' +
                '    <div style="display: flex; align-items: center; gap: 16px;">' +
                '        <button class="btn btn-secondary" onclick="navigateTo(\\'merchants\\')"><i class="ri-arrow-left-line"></i>返回</button>' +
                '        <h1 class="page-title">商户详情 - ' + escapeHtml(merchant.username) + '</h1>' +
                '    </div>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-primary" onclick="loginAsMerchant(\\'' + merchant.id + '\\')"><i class="ri-login-box-line"></i>登录用户中心</button>' +
                '        <button class="btn btn-secondary" onclick="showEditMerchantModal()"><i class="ri-edit-line"></i>编辑</button>' +
                statusButton +
                '    </div>' +
                '</div>' +
                '<div class="stats-grid fade-in">' +
                '    <div class="stat-card"><div class="stat-header"><span class="stat-label">今日收入</span><div class="stat-icon green"><i class="ri-money-cny-circle-line"></i></div></div><div class="stat-value">' + formatMoney(merchant.todayIncome || 0) + '</div><div class="stat-change up"><span>今日订单: ' + (merchant.todayOrders || 0) + '</span></div></div>' +
                '    <div class="stat-card"><div class="stat-header"><span class="stat-label">昨日收入</span><div class="stat-icon blue"><i class="ri-line-chart-line"></i></div></div><div class="stat-value">' + formatMoney(merchant.yesterdayIncome || 0) + '</div><div class="stat-change"><span>昨日订单: ' + (merchant.yesterdayOrders || 0) + '</span></div></div>' +
                '    <div class="stat-card"><div class="stat-header"><span class="stat-label">总余额</span><div class="stat-icon yellow"><i class="ri-wallet-line"></i></div></div><div class="stat-value">' + formatMoney(merchant.balance || 0) + '</div><div class="stat-change"><span>冻结: ' + formatMoney(merchant.frozenBalance || 0) + '</span></div></div>' +
                '    <div class="stat-card"><div class="stat-header"><span class="stat-label">总收入</span><div class="stat-icon purple"><i class="ri-bar-chart-line"></i></div></div><div class="stat-value">' + formatMoney(merchant.totalIncome || 0) + '</div><div class="stat-change"><span>总订单: ' + (merchant.totalOrders || 0) + '</span></div></div>' +
                '</div>' +
                '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px;">' +
                '    <div class="card fade-in"><div class="card-header"><h3 class="card-title">基本信息</h3></div><div class="card-body"><div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">' +
                detailItem('商户ID', '<code>' + escapeHtml(merchant.id) + '</code>') +
                detailItem('用户名', escapeHtml(merchant.username)) +
                detailItem('邮箱', escapeHtml(merchant.email || '-')) +
                detailItem('状态', getStatusBadge(merchant.status, 'merchant')) +
                detailItem('QQ', escapeHtml(merchant.contactQq || '-')) +
                detailItem('手机', escapeHtml(merchant.contactWechat || '-')) +
                detailItem('创建时间', formatDate(merchant.createdAt)) +
                detailItem('最后登录', formatDate(merchant.lastLoginAt)) +
                '    </div></div></div>' +
                '    <div class="card fade-in"><div class="card-header"><h3 class="card-title">API 配置</h3></div><div class="card-body">' +
                detailItem('API Key', '<code style="word-break: break-all;">' + escapeHtml(merchant.apiKey || '-') + '</code>') +
                detailItem('签名方式', merchant.apiKeyType === 'md5' ? 'MD5' : 'HMAC-SHA256') +
                detailItem('异步通知地址', escapeHtml(merchant.notifyUrl || '-')) +
                detailItem('同步返回地址', escapeHtml(merchant.returnUrl || '-')) +
                detailItem('分组ID', escapeHtml(merchant.groupId || '-')) +
                '    </div></div>' +
                '</div>' +
                '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">' +
                '    <div class="card fade-in"><div class="card-header"><h3 class="card-title">最近订单</h3></div><div class="card-body" style="padding: 0;"><div class="table-container"><table class="data-table"><thead><tr><th>订单号</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>' + ordersHtml + '</tbody></table></div></div></div>' +
                '    <div class="card fade-in"><div class="card-header"><h3 class="card-title">最近结算</h3></div><div class="card-body" style="padding: 0;"><div class="table-container"><table class="data-table"><thead><tr><th>结算ID</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>' + settlementsHtml + '</tbody></table></div></div></div>' +
                '</div>';
        }

        function detailItem(label, value) {
            return '<div class="form-group">' +
                '<label class="form-label" style="color: var(--text-tertiary); font-size: 12px;">' + label + '</label>' +
                '<div style="padding: 8px; word-break: break-all;">' + value + '</div>' +
                '</div>';
        }

        function renderOrders() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">订单管理</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-secondary" onclick="showToast(\\'success\\', \\'导出成功\\', \\'订单数据已导出\\')">' +
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
                        '    <button class="btn btn-sm btn-secondary" onclick="showToast(\\'info\\', \\'查看详情\\', \\'订单详情页面开发中\\')">' +
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
                            '<button class="btn btn-sm btn-primary" onclick="handleSettlement(\\'' + settlement.id + '\\', \\'approve\\')">批准</button>' +
                            '<button class="btn btn-sm btn-danger" onclick="handleSettlement(\\'' + settlement.id + '\\', \\'reject\\')">拒绝</button>' +
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
                '                <tbody id="paymentTypesTableBody">' +
                '                    <tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info" id="paymentTypesCount">共 0 条记录</div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载支付方式数据
        async function loadPaymentTypesData() {
            try {
                var result = await api.getPaymentTypes();
                var tbody = document.getElementById('paymentTypesTableBody');
                var countEl = document.getElementById('paymentTypesCount');
                if (!tbody) return;

                var list = result.data || [];
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-tertiary);">暂无支付方式数据</td></tr>';
                    if (countEl) countEl.textContent = '共 0 条记录';
                    return;
                }

                var html = '';
                list.forEach(function(item) {
                    html += '<tr>' +
                        '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">' + (item.name || '') + '</code></td>' +
                        '<td>' + (item.displayName || '') + '</td>' +
                        '<td><i class="' + (item.icon || 'ri-bank-card-line') + '" style="font-size: 24px;"></i></td>' +
                        '<td>' + (item.status === 1 ? '<span class="badge success">启用</span>' : '<span class="badge error">禁用</span>') + '</td>' +
                        '<td>' + (item.sortOrder || 0) + '</td>' +
                        '<td>' +
                        '    <button class="btn btn-sm btn-secondary" onclick="editPaymentType(\\'' + item.id + '\\')" title="编辑"><i class="ri-edit-line"></i></button>' +
                        '    <button class="btn btn-sm ' + (item.status === 1 ? 'btn-warning' : 'btn-success') + '" onclick="togglePaymentTypeStatus(\\'' + item.id + '\\', ' + (item.status === 1 ? 0 : 1) + ')" title="' + (item.status === 1 ? '禁用' : '启用') + '">' +
                        '        <i class="' + (item.status === 1 ? 'ri-pause-circle-line' : 'ri-play-circle-line') + '"></i>' +
                        '    </button>' +
                        '</td>' +
                        '</tr>';
                });
                tbody.innerHTML = html;
                if (countEl) countEl.textContent = '共 ' + list.length + ' 条记录';
            } catch (error) {
                console.error('加载支付方式失败:', error);
                showToast('error', '加载失败', '无法获取支付方式数据');
            }
        }

        function renderChannels() {
            return '<div class="page-header">' +
                '    <h1 class="page-title">支付通道</h1>' +
                '    <div class="page-actions">' +
                '        <button class="btn btn-primary" onclick="showModal(\\'createChannel\\')">' +
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
                '                        <th>通道名称</th>' +
                '                        <th>支付方式</th>' +
                '                        <th>插件</th>' +
                '                        <th>费率</th>' +
                '                        <th>金额范围</th>' +
                '                        <th>状态</th>' +
                '                        <th>操作</th>' +
                '                    </tr>' +
                '                </thead>' +
                '                <tbody id="channelsTableBody">' +
                '                    <tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info" id="channelsCount">共 0 条记录</div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载支付通道数据
        async function loadChannelsData() {
            try {
                var result = await api.getChannels();
                var tbody = document.getElementById('channelsTableBody');
                var countEl = document.getElementById('channelsCount');
                if (!tbody) return;

                var list = result.data || [];
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-tertiary);">暂无支付通道数据</td></tr>';
                    if (countEl) countEl.textContent = '共 0 条记录';
                    return;
                }

                var html = '';
                list.forEach(function(channel) {
                    var minStr = channel.minAmount ? formatMoney(channel.minAmount) : '不限';
                    var maxStr = channel.maxAmount ? formatMoney(channel.maxAmount) : '不限';
                    html += '<tr>' +
                        '<td>' + (channel.name || '') + '</td>' +
                        '<td><i class="' + getPaymentTypeIcon(channel.paymentType) + '" style="margin-right: 4px;"></i>' + (channel.paymentTypeDisplay || getPaymentTypeName(channel.paymentType)) + '</td>' +
                        '<td>' + (channel.plugin || '') + '</td>' +
                        '<td>' + ((channel.feeRate || 0) * 100).toFixed(2) + '%</td>' +
                        '<td>' + minStr + ' - ' + maxStr + '</td>' +
                        '<td>' +
                        '    <label class="toggle-switch" style="display: inline-flex;">' +
                        '        <input type="checkbox" ' + (channel.status === 1 ? 'checked' : '') + ' onchange="toggleChannelStatus(\\'' + channel.id + '\\', this.checked ? 1 : 0)">' +
                        '        <span class="toggle-slider"></span>' +
                        '    </label>' +
                        '</td>' +
                        '<td>' +
                        '    <div style="display: flex; gap: 8px;">' +
                        '        <button class="btn btn-sm btn-secondary" onclick="editChannel(\\'' + channel.id + '\\')" title="编辑"><i class="ri-edit-line"></i></button>' +
                        '        <button class="btn btn-sm btn-secondary" onclick="showChannelConfig(\\'' + channel.id + '\\')" title="配置"><i class="ri-settings-3-line"></i></button>' +
                        '        <button class="btn btn-sm btn-danger" onclick="deleteChannel(\\'' + channel.id + '\\', \\'' + (channel.name || '') + '\\')" title="删除"><i class="ri-delete-bin-line"></i></button>' +
                        '    </div>' +
                        '</td>' +
                        '</tr>';
                });
                tbody.innerHTML = html;
                if (countEl) countEl.textContent = '共 ' + list.length + ' 条记录';
            } catch (error) {
                console.error('加载支付通道失败:', error);
                showToast('error', '加载失败', '无法获取支付通道数据');
            }
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
                '                <input type="text" class="form-input" id="config_site_name" data-config-key="site_name" placeholder="加载中...">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">系统URL</label>' +
                '                <input type="text" class="form-input" id="config_site_url" data-config-key="site_url" placeholder="加载中...">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">是否开启注册</label>' +
                '                <select class="form-input form-select" id="config_enable_register" data-config-key="enable_register">' +
                '                    <option value="1">开启</option>' +
                '                    <option value="0">关闭</option>' +
                '                </select>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">是否开启商户审核</label>' +
                '                <select class="form-input form-select" id="config_enable_review" data-config-key="enable_review">' +
                '                    <option value="1">开启</option>' +
                '                    <option value="0">关闭</option>' +
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
                '                <label class="form-label">最低结算金额 (元)</label>' +
                '                <input type="number" class="form-input" id="config_min_settle_amount" data-config-key="min_settle_amount" placeholder="加载中...">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">结算手续费 (元)</label>' +
                '                <input type="number" class="form-input" id="config_settle_fee" data-config-key="settle_fee" placeholder="加载中...">' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">订单过期时间 (分钟)</label>' +
                '                <input type="number" class="form-input" id="config_order_expire_minutes" data-config-key="order_expire_minutes" placeholder="加载中...">' +
                '                <div class="form-hint">未支付订单自动关闭时间</div>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">通知重试次数</label>' +
                '                <input type="number" class="form-input" id="config_notify_retry_count" data-config-key="notify_retry_count" placeholder="加载中...">' +
                '                <div class="form-hint">异步通知失败重试次数</div>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">通知重试间隔</label>' +
                '                <input type="text" class="form-input" id="config_notify_retry_interval" data-config-key="notify_retry_interval" placeholder="加载中...">' +
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
                '                <textarea class="form-input form-textarea" id="config_ip_whitelist" data-config-key="ip_whitelist" placeholder="每行一个IP地址，留空表示不限制"></textarea>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">是否开启IP白名单</label>' +
                '                <select class="form-input form-select" id="config_enable_ip_whitelist" data-config-key="enable_ip_whitelist">' +
                '                    <option value="1">开启</option>' +
                '                    <option value="0">关闭</option>' +
                '                </select>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">是否开启域名白名单</label>' +
                '                <select class="form-input form-select" id="config_enable_domain_whitelist" data-config-key="enable_domain_whitelist">' +
                '                    <option value="1">开启</option>' +
                '                    <option value="0">关闭</option>' +
                '                </select>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">是否开启实名认证</label>' +
                '                <select class="form-input form-select" id="config_enable_cert_verify" data-config-key="enable_cert_verify">' +
                '                    <option value="1">开启</option>' +
                '                    <option value="0">关闭</option>' +
                '                </select>' +
                '            </div>' +
                '            <div class="form-group">' +
                '                <label class="form-label">是否开启风控</label>' +
                '                <select class="form-input form-select" id="config_enable_risk_control" data-config-key="enable_risk_control">' +
                '                    <option value="1">开启</option>' +
                '                    <option value="0">关闭</option>' +
                '                </select>' +
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
                '                <input type="email" class="form-input" id="config_admin_email" data-config-key="admin_email" placeholder="加载中...">' +
                '            </div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载系统配置数据
        async function loadSettingsData() {
            try {
                var result = await api.getConfig();
                var config = (result.success && result.data) ? result.data : {};
                // 遍历所有带 data-config-key 的表单元素，填充真实配置值
                var elements = document.querySelectorAll('[data-config-key]');
                elements.forEach(function(el) {
                    var key = el.getAttribute('data-config-key');
                    var val = config[key] !== undefined ? config[key] : '';
                    if (el.tagName === 'SELECT') {
                        // 找到匹配的 option
                        var matched = false;
                        for (var i = 0; i < el.options.length; i++) {
                            if (el.options[i].value === String(val)) {
                                el.options[i].selected = true;
                                matched = true;
                            } else {
                                el.options[i].selected = false;
                            }
                        }
                        if (!matched && val !== '') {
                            // 没有匹配项时保持第一个
                        }
                    } else {
                        el.value = val;
                    }
                });
            } catch (error) {
                console.error('加载系统配置失败:', error);
                showToast('error', '加载失败', '无法获取系统配置');
            }
        }

        // 保存设置
        async function saveSettings() {
            try {
                var configData = {};
                var elements = document.querySelectorAll('[data-config-key]');
                elements.forEach(function(el) {
                    var key = el.getAttribute('data-config-key');
                    configData[key] = el.value;
                });
                
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
                '            <input type="text" class="form-input" id="logsKeyword" placeholder="搜索操作内容...">' +
                '            <button class="btn btn-secondary" onclick="loadLogsData()">' +
                '                <i class="ri-search-line"></i>' +
                '                搜索' +
                '            </button>' +
                '            <button class="btn btn-secondary" onclick="document.getElementById(\\'logsKeyword\\').value=\\'\\';loadLogsData()">' +
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
                '                <tbody id="logsTableBody">' +
                '                    <tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-tertiary);">加载中...</td></tr>' +
                '                </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="pagination">' +
                '            <div class="pagination-info" id="logsCount">共 0 条记录</div>' +
                '        </div>' +
                '    </div>' +
                '</div>';
        }

        // 加载操作日志数据
        async function loadLogsData() {
            try {
                var keywordEl = document.getElementById('logsKeyword');
                var params = {};
                if (keywordEl && keywordEl.value.trim()) {
                    params.keyword = keywordEl.value.trim();
                }
                var result = await api.getLogs(params);
                var tbody = document.getElementById('logsTableBody');
                var countEl = document.getElementById('logsCount');
                if (!tbody) return;

                var list = result.data || [];
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-tertiary);">暂无操作日志</td></tr>';
                    if (countEl) countEl.textContent = '共 0 条记录';
                    return;
                }

                var html = '';
                list.forEach(function(log) {
                    html += '<tr>' +
                        '<td>' + (log.id || '') + '</td>' +
                        '<td>' + (log.user || '系统') + '</td>' +
                        '<td><span class="badge info">' + (log.action || '') + '</span></td>' +
                        '<td>' + (log.detail || (log.target ? '目标: ' + log.target : '-')) + '</td>' +
                        '<td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">' + (log.ip || '-') + '</code></td>' +
                        '<td>' + formatDate(log.createdAt) + '</td>' +
                        '</tr>';
                });
                tbody.innerHTML = html;
                if (countEl) countEl.textContent = '共 ' + list.length + ' 条记录';
            } catch (error) {
                console.error('加载操作日志失败:', error);
                showToast('error', '加载失败', '无法获取操作日志数据');
            }
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
            settlements: loadSettlementsData,
            'payment-types': loadPaymentTypesData,
            channels: loadChannelsData,
            settings: loadSettingsData,
            logs: loadLogsData
        };

        // 导航到商户详情页面
        async function navigateToMerchantDetail(merchantId) {
            state.currentPage = 'merchantDetail';

            document.querySelectorAll('.nav-item').forEach(function(item) {
                item.classList.remove('active');
                if (item.dataset.page === 'merchants') {
                    item.classList.add('active');
                }
            });

            var breadcrumb = document.getElementById('breadcrumbCurrent');
            if (breadcrumb) breadcrumb.textContent = '商户详情';

            var mainContent = document.getElementById('mainContent');
            if (mainContent) {
                mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
            }

            try {
                var result = await api.getMerchantDetail(merchantId);
                if (!result.success) {
                    showToast('error', '获取失败', result.message || '商户详情加载失败');
                    navigateTo('merchants');
                    return;
                }

                if (mainContent) {
                    mainContent.innerHTML = renderMerchantDetail(result.data);
                }
            } catch (error) {
                console.error('获取商户详情失败:', error);
                showToast('error', '获取失败', '系统错误');
                navigateTo('merchants');
            }

            if (window.innerWidth <= 1024) {
                closeSidebar();
            }
        }

        // 导航到指定页面
        function navigateTo(page) {
            state.currentPage = page;

            // 登录页面特殊处理
            if (page === 'login') {
                document.querySelector('.layout').innerHTML = renderLogin();
                return;
            }

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
                        data: [],
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
                            data: [],
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
                            data: []
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
                            data: [],
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
        async function showModal(type, data) {
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
            } else if (type === 'createChannel' || type === 'editChannel') {
                var isEdit = type === 'editChannel';
                var channelData = data || {};
                
                // 获取支付方式列表
                var paymentTypes = [];
                try {
                    var ptResult = await api.getPaymentTypes();
                    paymentTypes = ptResult.data || [];
                } catch (e) {
                    console.error('获取支付方式失败:', e);
                }
                
                var pluginOptions = [];
                try {
                    var pluginResult = await api.getPlugins();
                    pluginOptions = pluginResult.data || [];
                } catch (e) {
                    console.error('获取插件列表失败:', e);
                }
                
                // 保存到全局变量供联动使用
                window._pluginOptions = pluginOptions;
                window._paymentTypes = paymentTypes;
                
                var pluginSelectOptions = pluginOptions.map(function(p) {
                    return '<option value="' + p.id + '" ' + (channelData.plugin === p.id ? 'selected' : '') + '>' + p.name + '</option>';
                }).join('');
                
                var paymentTypeOptions = paymentTypes.map(function(pt) {
                    return '<option value="' + pt.id + '" ' + (channelData.paymentTypeId === pt.id ? 'selected' : '') + '>' + (pt.displayName || pt.name) + '</option>';
                }).join('');
                
                var modalHTML = '<div class="modal-overlay" id="modalOverlay">' +
                    '<div class="modal" style="max-width: 600px;">' +
                    '    <div class="modal-header">' +
                    '        <span class="modal-title">' + (isEdit ? '编辑通道' : '添加通道') + '</span>' +
                    '        <button class="modal-close" onclick="closeModal()">' +
                    '            <i class="ri-close-line"></i>' +
                    '        </button>' +
                    '    </div>' +
                    '    <div class="modal-body">' +
                    '        <input type="hidden" id="channelId" value="' + (channelData.id || '') + '">' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">通道名称 <span style="color: var(--error);">*</span></label>' +
                    '            <input type="text" class="form-input" id="channelName" value="' + (channelData.name || '') + '" placeholder="请输入通道名称">' +
                    '        </div>' +
                    '        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">支付方式 <span style="color: var(--error);">*</span></label>' +
                    '                <select class="form-input form-select" id="channelPaymentTypeId" onchange="onPaymentTypeChange()">' +
                    '                    <option value="">请选择支付方式</option>' +
                    paymentTypeOptions +
                    '                </select>' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">插件 <span style="color: var(--error);">*</span></label>' +
                    '                <select class="form-input form-select" id="channelPlugin" onchange="onPluginChange()">' +
                    '                    <option value="">请选择插件</option>' +
                    pluginSelectOptions +
                    '                </select>' +
                    '            </div>' +
                    '        </div>' +
                    '        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">费率 (%)</label>' +
                    '                <input type="number" class="form-input" id="channelFeeRate" value="' + ((channelData.feeRate || 0) * 100) + '" step="0.01" min="0" max="100" placeholder="0">' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">最小金额</label>' +
                    '                <input type="number" class="form-input" id="channelMinAmount" value="' + (channelData.minAmount || '') + '" step="0.01" min="0" placeholder="不限">' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">最大金额</label>' +
                    '                <input type="number" class="form-input" id="channelMaxAmount" value="' + (channelData.maxAmount || '') + '" step="0.01" min="0" placeholder="不限">' +
                    '            </div>' +
                    '        </div>' +
                    '        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">每日限额</label>' +
                    '                <input type="number" class="form-input" id="channelDailyLimit" value="' + (channelData.dailyLimit || '') + '" step="0.01" min="0" placeholder="不限">' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">开始时间</label>' +
                    '                <input type="number" class="form-input" id="channelTimeStart" value="' + (channelData.timeStart || '') + '" min="0" max="23" placeholder="0-23">' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">结束时间</label>' +
                    '                <input type="number" class="form-input" id="channelTimeStop" value="' + (channelData.timeStop || '') + '" min="0" max="23" placeholder="0-23">' +
                    '            </div>' +
                    '        </div>' +
                    '        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">排序</label>' +
                    '                <input type="number" class="form-input" id="channelSortOrder" value="' + (channelData.sortOrder || 0) + '" min="0" placeholder="0">' +
                    '                <div class="form-hint">数值越小越靠前</div>' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">状态</label>' +
                    '                <select class="form-input form-select" id="channelStatus">' +
                    '                    <option value="1" ' + (channelData.status === 1 || !isEdit ? 'selected' : '') + '>启用</option>' +
                    '                    <option value="0" ' + (channelData.status === 0 ? 'selected' : '') + '>禁用</option>' +
                    '                </select>' +
                    '            </div>' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">描述</label>' +
                    '            <textarea class="form-input" id="channelDescription" rows="3" placeholder="通道描述信息">' + (channelData.description || '') + '</textarea>' +
                    '        </div>' +
                    '    </div>' +
                    '    <div class="modal-footer">' +
                    '        <button class="btn btn-secondary" onclick="closeModal()">取消</button>' +
                    '        <button class="btn btn-primary" onclick="submitChannel()">' + (isEdit ? '保存' : '创建') + '</button>' +
                    '    </div>' +
                    '</div>' +
                    '</div>';

                document.body.insertAdjacentHTML('beforeend', modalHTML);
                setTimeout(function() {
                    document.getElementById('modalOverlay').classList.add('active');
                }, 10);
            } else if (type === 'editPaymentType') {
                var paymentTypeData = data || {};

                var modalHTML = '<div class="modal-overlay" id="modalOverlay">' +
                    '<div class="modal" style="max-width: 500px;">' +
                    '    <div class="modal-header">' +
                    '        <span class="modal-title">编辑支付方式</span>' +
                    '        <button class="modal-close" onclick="closeModal()">' +
                    '            <i class="ri-close-line"></i>' +
                    '        </button>' +
                    '    </div>' +
                    '    <div class="modal-body">' +
                    '        <input type="hidden" id="paymentTypeId" value="' + (paymentTypeData.id || '') + '">' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">标识</label>' +
                    '            <input type="text" class="form-input" value="' + (paymentTypeData.name || '') + '" disabled style="background: var(--bg-tertiary); color: var(--text-tertiary);">' +
                    '            <div class="form-hint">标识不可修改</div>' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">显示名称 <span style="color: var(--error);">*</span></label>' +
                    '            <input type="text" class="form-input" id="paymentTypeDisplayName" value="' + (paymentTypeData.displayName || '') + '" placeholder="请输入显示名称">' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">图标</label>' +
                    '            <input type="text" class="form-input" id="paymentTypeIcon" value="' + (paymentTypeData.icon || '') + '" placeholder="图标 class 或 URL">' +
                    '            <div class="form-hint">支持 Remix Icon class 或图片 URL</div>' +
                    '        </div>' +
                    '        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">排序</label>' +
                    '                <input type="number" class="form-input" id="paymentTypeSortOrder" value="' + (paymentTypeData.sortOrder || 0) + '" min="0" placeholder="0">' +
                    '                <div class="form-hint">数值越小越靠前</div>' +
                    '            </div>' +
                    '            <div class="form-group">' +
                    '                <label class="form-label">状态</label>' +
                    '                <select class="form-input form-select" id="paymentTypeStatus">' +
                    '                    <option value="1" ' + (paymentTypeData.status === 1 ? 'selected' : '') + '>启用</option>' +
                    '                    <option value="0" ' + (paymentTypeData.status === 0 ? 'selected' : '') + '>禁用</option>' +
                    '                </select>' +
                    '            </div>' +
                    '        </div>' +
                    '        <div class="form-group">' +
                    '            <label class="form-label">描述</label>' +
                    '            <textarea class="form-input" id="paymentTypeDescription" rows="3" placeholder="支付方式描述信息">' + (paymentTypeData.description || '') + '</textarea>' +
                    '        </div>' +
                    '    </div>' +
                    '    <div class="modal-footer">' +
                    '        <button class="btn btn-secondary" onclick="closeModal()">取消</button>' +
                    '        <button class="btn btn-primary" onclick="submitPaymentType()">保存</button>' +
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

        // 显示商户编辑弹窗
        function showEditMerchantModal() {
            var merchant = state.currentMerchant;
            if (!merchant) {
                showToast('error', '操作失败', '商户信息未加载');
                return;
            }

            var modalHTML = '<div class="modal-overlay" id="modalOverlay">' +
                '<div class="modal">' +
                '    <div class="modal-header">' +
                '        <span class="modal-title">编辑商户信息</span>' +
                '        <button class="modal-close" onclick="closeModal()"><i class="ri-close-line"></i></button>' +
                '    </div>' +
                '    <div class="modal-body">' +
                '        <div class="form-group"><label class="form-label">邮箱</label><input type="email" class="form-input" id="editMerchantEmail" value="' + escapeHtml(merchant.email || '') + '" placeholder="请输入邮箱"></div>' +
                '        <div class="form-group"><label class="form-label">QQ</label><input type="text" class="form-input" id="editMerchantContactQq" value="' + escapeHtml(merchant.contactQq || '') + '" placeholder="请输入QQ号"></div>' +
                '        <div class="form-group"><label class="form-label">手机</label><input type="text" class="form-input" id="editMerchantContactWechat" value="' + escapeHtml(merchant.contactWechat || '') + '" placeholder="请输入手机号"></div>' +
                '        <div class="form-group"><label class="form-label">异步通知地址</label><input type="url" class="form-input" id="editMerchantNotifyUrl" value="' + escapeHtml(merchant.notifyUrl || '') + '" placeholder="https://example.com/notify"></div>' +
                '        <div class="form-group"><label class="form-label">同步返回地址</label><input type="url" class="form-input" id="editMerchantReturnUrl" value="' + escapeHtml(merchant.returnUrl || '') + '" placeholder="https://example.com/return"></div>' +
                '        <div class="form-group"><label class="form-label">分组ID</label><input type="text" class="form-input" id="editMerchantGroupId" value="' + escapeHtml(merchant.groupId || '') + '" placeholder="请输入分组ID"></div>' +
                '    </div>' +
                '    <div class="modal-footer">' +
                '        <button class="btn btn-secondary" onclick="closeModal()">取消</button>' +
                '        <button class="btn btn-primary" id="editMerchantSubmitBtn" onclick="submitMerchantEdit()">保存</button>' +
                '    </div>' +
                '</div>' +
                '</div>';

            document.body.insertAdjacentHTML('beforeend', modalHTML);
            setTimeout(function() {
                var overlay = document.getElementById('modalOverlay');
                if (overlay) overlay.classList.add('active');
            }, 10);
        }

        // 提交商户编辑
        async function submitMerchantEdit() {
            var merchant = state.currentMerchant;
            if (!merchant) {
                showToast('error', '保存失败', '商户信息未加载');
                return;
            }

            var submitBtn = document.getElementById('editMerchantSubmitBtn');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = '保存中...';
            }

            var merchantData = {
                email: document.getElementById('editMerchantEmail').value || '',
                contactQq: document.getElementById('editMerchantContactQq').value || '',
                contactWechat: document.getElementById('editMerchantContactWechat').value || '',
                notifyUrl: document.getElementById('editMerchantNotifyUrl').value || '',
                returnUrl: document.getElementById('editMerchantReturnUrl').value || '',
                groupId: document.getElementById('editMerchantGroupId').value || ''
            };

            try {
                var result = await api.updateMerchant(merchant.id, merchantData);
                if (result.success) {
                    showToast('success', '保存成功', result.message || '商户信息已更新');
                    closeModal();
                    navigateToMerchantDetail(merchant.id);
                } else {
                    showToast('error', '保存失败', result.message);
                }
            } catch (error) {
                showToast('error', '保存失败', '网络错误，请重试');
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '保存';
                }
            }
        }

        // 一键登录商户用户中心
        async function loginAsMerchant(id) {
            var userWindow = window.open('', '_blank');
            if (!userWindow) {
                showToast('error', '打开失败', '浏览器阻止了新窗口，请允许弹窗后重试');
                return;
            }

            userWindow.document.write('<!DOCTYPE html><html><head><title>正在登录...</title><meta charset="utf-8"></head><body style="font-family: sans-serif; padding: 24px;">正在进入用户中心...</body></html>');

            try {
                var result = await api.getMerchantLoginToken(id);
                if (result.success && result.data && result.data.token) {
                    userWindow.location.href = '/user?token=' + encodeURIComponent(result.data.token);
                    showToast('success', '生成成功', '已打开商户用户中心');
                } else {
                    userWindow.close();
                    showToast('error', '生成失败', result.message || '无法生成登录链接');
                }
            } catch (error) {
                userWindow.close();
                showToast('error', '登录失败', '网络错误，请重试');
            }
        }

        // 切换商户状态
        function handleMerchantStatus(id, status) {
            var actionText = status === 1 ? '启用' : '禁用';
            showConfirm('确认' + actionText + '商户', '确定要' + actionText + '该商户吗？', async function() {
                try {
                    var result = await api.updateMerchantStatus(id, status);
                    if (result.success) {
                        showToast('success', '操作成功', '商户已' + actionText);
                        navigateToMerchantDetail(id);
                    } else {
                        showToast('error', '操作失败', result.message);
                    }
                } catch (error) {
                    showToast('error', '操作失败', '网络错误，请重试');
                }
            });
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

        // 插件选择联动
        function onPluginChange() {
            var pluginId = document.getElementById('channelPlugin').value;
            var paymentTypeSelect = document.getElementById('channelPaymentTypeId');
            var currentPaymentType = paymentTypeSelect.value;
            
            // 清空支付方式选择
            paymentTypeSelect.innerHTML = '<option value="">请选择支付方式</option>';
            
            if (!pluginId) {
                // 如果没有选择插件，显示所有支付方式
                window._paymentTypes.forEach(function(pt) {
                    var option = document.createElement('option');
                    option.value = pt.id;
                    option.textContent = pt.displayName || pt.name;
                    if (pt.id === currentPaymentType) option.selected = true;
                    paymentTypeSelect.appendChild(option);
                });
                return;
            }
            
            // 找到选中的插件
            var selectedPlugin = window._pluginOptions.find(function(p) { return p.id === pluginId; });
            if (!selectedPlugin || !selectedPlugin.supportedTypes) return;
            
            // 根据插件支持的支付方式过滤
            window._paymentTypes.forEach(function(pt) {
                if (selectedPlugin.supportedTypes.includes(pt.name)) {
                    var option = document.createElement('option');
                    option.value = pt.id;
                    option.textContent = pt.displayName || pt.name;
                    if (pt.id === currentPaymentType) option.selected = true;
                    paymentTypeSelect.appendChild(option);
                }
            });
        }
        
        // 支付方式选择联动
        function onPaymentTypeChange() {
            var paymentTypeId = document.getElementById('channelPaymentTypeId').value;
            var pluginSelect = document.getElementById('channelPlugin');
            var currentPlugin = pluginSelect.value;
            
            // 清空插件选择
            pluginSelect.innerHTML = '<option value="">请选择插件</option>';
            
            if (!paymentTypeId) {
                // 如果没有选择支付方式，显示所有插件
                window._pluginOptions.forEach(function(p) {
                    var option = document.createElement('option');
                    option.value = p.id;
                    option.textContent = p.name;
                    if (p.id === currentPlugin) option.selected = true;
                    pluginSelect.appendChild(option);
                });
                return;
            }
            
            // 找到选中的支付方式
            var selectedPT = window._paymentTypes.find(function(pt) { return pt.id === paymentTypeId; });
            if (!selectedPT) return;
            
            // 根据支付方式过滤支持该方式的插件
            window._pluginOptions.forEach(function(p) {
                if (p.supportedTypes && p.supportedTypes.includes(selectedPT.name)) {
                    var option = document.createElement('option');
                    option.value = p.id;
                    option.textContent = p.name;
                    if (p.id === currentPlugin) option.selected = true;
                    pluginSelect.appendChild(option);
                }
            });
        }
        
        // 提交通道表单
        async function submitChannel() {
            var id = document.getElementById('channelId').value;
            var name = document.getElementById('channelName').value;
            var paymentTypeId = document.getElementById('channelPaymentTypeId').value;
            var plugin = document.getElementById('channelPlugin').value;
            var feeRate = parseFloat(document.getElementById('channelFeeRate').value) || 0;
            var minAmount = parseFloat(document.getElementById('channelMinAmount').value) || 0;
            var maxAmount = parseFloat(document.getElementById('channelMaxAmount').value) || 0;
            var dailyLimit = parseFloat(document.getElementById('channelDailyLimit').value) || 0;
            var timeStart = document.getElementById('channelTimeStart').value;
            var timeStop = document.getElementById('channelTimeStop').value;
            var sortOrder = parseInt(document.getElementById('channelSortOrder').value) || 0;
            var status = parseInt(document.getElementById('channelStatus').value);
            var description = document.getElementById('channelDescription').value;

            if (!name) {
                showToast('error', '验证失败', '通道名称不能为空');
                return;
            }
            if (!paymentTypeId) {
                showToast('error', '验证失败', '请选择支付方式');
                return;
            }
            if (!plugin) {
                showToast('error', '验证失败', '请选择插件');
                return;
            }

            var channelData = {
                name: name,
                paymentTypeId: paymentTypeId,
                plugin: plugin,
                feeRate: feeRate / 100,
                minAmount: minAmount,
                maxAmount: maxAmount,
                dailyLimit: dailyLimit,
                timeStart: timeStart !== '' ? parseInt(timeStart) : null,
                timeStop: timeStop !== '' ? parseInt(timeStop) : null,
                sortOrder: sortOrder,
                status: status,
                description: description || null
            };

            try {
                var result;
                if (id) {
                    result = await api.updateChannel(id, channelData);
                } else {
                    result = await api.createChannel(channelData);
                }

                if (result.success) {
                    showToast('success', id ? '更新成功' : '创建成功', '通道 ' + name + ' 已' + (id ? '更新' : '创建'));
                    closeModal();
                    if (state.currentPage === 'channels') {
                        loadChannelsData();
                    }
                } else {
                    showToast('error', id ? '更新失败' : '创建失败', result.message);
                }
            } catch (error) {
                showToast('error', id ? '更新失败' : '创建失败', '网络错误，请重试');
            }
        }

        // 提交支付方式表单
        async function submitPaymentType() {
            var id = document.getElementById('paymentTypeId').value;
            var displayName = document.getElementById('paymentTypeDisplayName').value;
            var icon = document.getElementById('paymentTypeIcon').value;
            var sortOrder = parseInt(document.getElementById('paymentTypeSortOrder').value) || 0;
            var status = parseInt(document.getElementById('paymentTypeStatus').value);
            var description = document.getElementById('paymentTypeDescription').value;

            if (!displayName) {
                showToast('error', '验证失败', '显示名称不能为空');
                return;
            }

            var paymentTypeData = {
                displayName: displayName,
                icon: icon || null,
                sortOrder: sortOrder,
                status: status,
                description: description || null
            };

            try {
                var result = await api.updatePaymentType(id, paymentTypeData);
                if (result.success) {
                    showToast('success', '更新成功', '支付方式已更新');
                    closeModal();
                    if (state.currentPage === 'paymentTypes') {
                        loadPaymentTypesData();
                    }
                } else {
                    showToast('error', '更新失败', result.message);
                }
            } catch (error) {
                showToast('error', '更新失败', '网络错误，请重试');
            }
        }

        // 编辑支付方式
        async function editPaymentType(id) {
            try {
                var result = await api.getPaymentTypes();
                var paymentTypes = result.data || [];
                var paymentType = paymentTypes.find(function(pt) { return pt.id === id; });
                
                if (!paymentType) {
                    showToast('error', '错误', '支付方式不存在');
                    return;
                }
                
                showModal('editPaymentType', paymentType);
            } catch (error) {
                showToast('error', '加载失败', '无法获取支付方式数据');
            }
        }

        // 切换支付方式状态
        async function togglePaymentTypeStatus(id, status) {
            try {
                var result = await api.togglePaymentTypeStatus(id, status);
                if (result.success) {
                    showToast('success', '状态更新', '支付方式已' + (status === 1 ? '启用' : '禁用'));
                } else {
                    showToast('error', '更新失败', result.message);
                    loadPaymentTypesData();
                }
            } catch (error) {
                showToast('error', '更新失败', '网络错误，请重试');
                loadPaymentTypesData();
            }
        }

        // 编辑通道
        async function editChannel(id) {
            try {
                var result = await api.getChannels();
                var channels = result.data || [];
                var channel = channels.find(function(c) { return c.id === id; });
                
                if (!channel) {
                    showToast('error', '错误', '通道不存在');
                    return;
                }
                
                showModal('editChannel', channel);
            } catch (error) {
                showToast('error', '加载失败', '无法获取通道数据');
            }
        }

        // 删除通道
        async function deleteChannel(id, name) {
            showConfirm('删除确认', '确定要删除通道 "' + name + '" 吗？此操作不可撤销。', async function(confirmed) {
                if (!confirmed) return;
                
                try {
                    var result = await api.deleteChannel(id);
                    if (result.success) {
                        showToast('success', '删除成功', '通道已删除');
                        loadChannelsData();
                    } else {
                        showToast('error', '删除失败', result.message);
                    }
                } catch (error) {
                    showToast('error', '删除失败', '网络错误，请重试');
                }
            });
        }

        // 切换通道状态
        async function toggleChannelStatus(id, status) {
            try {
                var result = await api.toggleChannelStatus(id, status);
                if (result.success) {
                    showToast('success', '状态更新', '通道已' + (status === 1 ? '启用' : '禁用'));
                } else {
                    showToast('error', '更新失败', result.message);
                    loadChannelsData();
                }
            } catch (error) {
                showToast('error', '更新失败', '网络错误，请重试');
                loadChannelsData();
            }
        }

        // 显示通道配置
        async function showChannelConfig(id) {
            try {
                var result = await api.getChannels();
                var channels = result.data || [];
                var channel = channels.find(function(c) { return c.id === id; });
                
                if (!channel) {
                    showToast('error', '错误', '通道不存在');
                    return;
                }
                
                var config = {};
                try {
                    config = channel.config ? JSON.parse(channel.config) : {};
                } catch (e) {
                    config = {};
                }
                
                var configFields = '';
                if (channel.plugin === 'alipay') {
                    configFields =
                        '        <div class="form-group">' +
                        '            <label class="form-label">应用 ID (app_id)</label>' +
                        '            <input type="text" class="form-input" id="config_appId" value="' + (config.appId || '') + '" placeholder="支付宝应用ID">' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">应用私钥</label>' +
                        '            <textarea class="form-input" id="config_appSecret" rows="4" placeholder="应用私钥">' + (config.appSecret || '') + '</textarea>' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">支付宝公钥</label>' +
                        '            <textarea class="form-input" id="config_alipayPublicKey" rows="4" placeholder="支付宝公钥">' + (config.alipayPublicKey || '') + '</textarea>' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">签名类型</label>' +
                        '            <select class="form-input form-select" id="config_signType">' +
                        '                <option value="RSA2" ' + (config.signType === 'RSA2' ? 'selected' : '') + '>RSA2</option>' +
                        '                <option value="RSA" ' + (config.signType === 'RSA' ? 'selected' : '') + '>RSA</option>' +
                        '            </select>' +
                        '        </div>';
                } else if (channel.plugin === 'wxpay') {
                    configFields =
                        '        <div class="form-group">' +
                        '            <label class="form-label">商户号 (mch_id)</label>' +
                        '            <input type="text" class="form-input" id="config_appId" value="' + (config.appId || '') + '" placeholder="微信支付商户号">' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">API 密钥</label>' +
                        '            <input type="text" class="form-input" id="config_appSecret" value="' + (config.appSecret || '') + '" placeholder="API密钥">' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">API 证书序列号</label>' +
                        '            <input type="text" class="form-input" id="config_serialNo" value="' + (config.serialNo || '') + '" placeholder="证书序列号">' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">API 私钥</label>' +
                        '            <textarea class="form-input" id="config_privateKey" rows="4" placeholder="API私钥">' + (config.privateKey || '') + '</textarea>' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">微信平台公钥</label>' +
                        '            <textarea class="form-input" id="config_wxpayPublicKey" rows="4" placeholder="微信平台公钥">' + (config.wxpayPublicKey || '') + '</textarea>' +
                        '        </div>';
                } else if (channel.plugin === 'xunhupay') {
                    configFields =
                        '        <div class="form-group">' +
                        '            <label class="form-label">APP ID</label>' +
                        '            <input type="text" class="form-input" id="config_appId" value="' + (config.appId || '') + '" placeholder="虎皮椒 APP ID">' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">密钥 (APP SECRET)</label>' +
                        '            <input type="text" class="form-input" id="config_appSecret" value="' + (config.appSecret || '') + '" placeholder="虎皮椒密钥">' +
                        '        </div>' +
                        '        <div class="form-group">' +
                        '            <label class="form-label">通知地址</label>' +
                        '            <input type="text" class="form-input" id="config_notifyUrl" value="' + (config.notifyUrl || '') + '" placeholder="留空使用系统默认">' +
                        '            <div class="form-hint">留空则使用系统默认通知地址</div>' +
                        '        </div>';
                } else {
                    configFields =
                        '        <div class="form-group">' +
                        '            <label class="form-label">配置内容 (JSON)</label>' +
                        '            <textarea class="form-input" id="config_json" rows="10" placeholder="{}">' + JSON.stringify(config, null, 2) + '</textarea>' +
                        '            <div class="form-hint">请输入有效的 JSON 格式配置</div>' +
                        '        </div>';
                }
                
                var modalHTML = '<div class="modal-overlay" id="modalOverlay">' +
                    '<div class="modal" style="max-width: 500px;">' +
                    '    <div class="modal-header">' +
                    '        <span class="modal-title">通道配置 - ' + (channel.name || '') + '</span>' +
                    '        <button class="modal-close" onclick="closeModal()">' +
                    '            <i class="ri-close-line"></i>' +
                    '        </button>' +
                    '    </div>' +
                    '    <div class="modal-body">' +
                    '        <input type="hidden" id="configChannelId" value="' + id + '">' +
                    '        <input type="hidden" id="configChannelPlugin" value="' + (channel.plugin || '') + '">' +
                    configFields +
                    '    </div>' +
                    '    <div class="modal-footer">' +
                    '        <button class="btn btn-secondary" onclick="closeModal()">取消</button>' +
                    '        <button class="btn btn-primary" onclick="saveChannelConfig()">保存配置</button>' +
                    '    </div>' +
                    '</div>' +
                    '</div>';

                document.body.insertAdjacentHTML('beforeend', modalHTML);
                setTimeout(function() {
                    document.getElementById('modalOverlay').classList.add('active');
                }, 10);
            } catch (error) {
                showToast('error', '加载失败', '无法获取通道数据');
            }
        }

        // 保存通道配置
        async function saveChannelConfig() {
            var id = document.getElementById('configChannelId').value;
            var plugin = document.getElementById('configChannelPlugin').value;
            
            var config = {};
            
            if (plugin === 'alipay' || plugin === 'wxpay' || plugin === 'xunhupay') {
                var appId = document.getElementById('config_appId').value;
                var appSecret = document.getElementById('config_appSecret').value;
                
                if (!appId) {
                    showToast('error', '验证失败', '应用ID/商户号不能为空');
                    return;
                }
                
                config.appId = appId;
                config.appSecret = appSecret;
                
                if (plugin === 'alipay') {
                    config.alipayPublicKey = document.getElementById('config_alipayPublicKey').value;
                    config.signType = document.getElementById('config_signType').value;
                } else if (plugin === 'wxpay') {
                    config.serialNo = document.getElementById('config_serialNo').value;
                    config.privateKey = document.getElementById('config_privateKey').value;
                    config.wxpayPublicKey = document.getElementById('config_wxpayPublicKey').value;
                } else if (plugin === 'xunhupay') {
                    config.notifyUrl = document.getElementById('config_notifyUrl').value;
                }
            } else {
                var jsonStr = document.getElementById('config_json').value;
                try {
                    config = JSON.parse(jsonStr || '{}');
                } catch (e) {
                    showToast('error', '格式错误', '请输入有效的 JSON 格式');
                    return;
                }
            }
            
            try {
                var result = await api.updateChannel(id, { config: config });
                if (result.success) {
                    showToast('success', '保存成功', '通道配置已更新');
                    closeModal();
                    loadChannelsData();
                } else {
                    showToast('error', '保存失败', result.message);
                }
            } catch (error) {
                showToast('error', '保存失败', '网络错误，请重试');
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

        // 注册全局事件监听器（登录前后都需要）
        function setupEventListeners() {
            // 初始化主题
            initTheme();

            // 侧边栏切换按钮
            var sidebarToggle = document.getElementById('sidebarToggle');
            if (sidebarToggle && !sidebarToggle._bound) {
                sidebarToggle._bound = true;
                sidebarToggle.addEventListener('click', function() {
                    if (window.innerWidth <= 1024) {
                        openSidebar();
                    } else {
                        toggleSidebar();
                    }
                });
            }

            // 遮罩层点击
            var drawerOverlay = document.getElementById('drawerOverlay');
            if (drawerOverlay && !drawerOverlay._bound) {
                drawerOverlay._bound = true;
                drawerOverlay.addEventListener('click', closeSidebar);
            }

            // 主题切换
            var themeToggle = document.getElementById('themeToggle');
            if (themeToggle && !themeToggle._bound) {
                themeToggle._bound = true;
                themeToggle.addEventListener('click', toggleTheme);
            }

            // 导航点击
            document.querySelectorAll('.nav-item[data-page]').forEach(function(item) {
                if (!item._bound) {
                    item._bound = true;
                    item.addEventListener('click', function(e) {
                        e.preventDefault();
                        navigateTo(this.dataset.page);
                    });
                }
            });

            // 退出登录按钮
            var logoutBtn = document.querySelector('[data-action="logout"]');
            if (logoutBtn && !logoutBtn._bound) {
                logoutBtn._bound = true;
                logoutBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    handleLogout();
                });
            }

            // 监听系统主题变化
            if (!window._themeListenerBound) {
                window._themeListenerBound = true;
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                    if (!localStorage.getItem('theme')) {
                        var theme = e.matches ? 'dark' : 'light';
                        document.documentElement.setAttribute('data-theme', theme);
                        state.theme = theme;
                        var icon = document.querySelector('#themeToggle i');
                        if (icon) icon.className = theme === 'dark' ? 'ri-sun-line' : 'ri-moon-line';
                    }
                });
            }

            // 窗口大小变化处理
            if (!window._resizeListenerBound) {
                window._resizeListenerBound = true;
                window.addEventListener('resize', function() {
                    if (window.innerWidth > 1024) {
                        closeSidebar();
                    }
                });
            }
        }

        // 初始化
        document.addEventListener('DOMContentLoaded', function() {
            try {
                // 先注册事件监听器
                setupEventListeners();

                // 检查登录状态
                if (!isLoggedIn()) {
                    navigateTo('login');
                    return;
                }

                // 更新用户信息显示
                updateUserDisplay();

                // 渲染默认页面
                navigateTo('dashboard');
            } catch (e) {
                console.error('页面初始化失败:', e);
                // 如果初始化失败，至少显示登录页面
                try {
                    navigateTo('login');
                } catch (e2) {
                    document.getElementById('mainContent').innerHTML =
                        '<div style="text-align:center;padding:60px;">' +
                        '<h2 style="color:var(--error);">页面加载失败</h2>' +
                        '<p style="color:var(--text-secondary);margin-top:12px;">请打开浏览器控制台 (F12) 查看错误详情</p>' +
                        '<p style="color:var(--text-tertiary);margin-top:8px;font-size:12px;">' + (e.message || e) + '</p>' +
                        '</div>';
                }
            }
        });

        // 更新用户信息显示
        function updateUserDisplay() {
            if (state.user) {
                var avatarEl = document.getElementById('userAvatar');
                var nameEl = document.getElementById('userDisplayName');
                if (avatarEl) avatarEl.textContent = (state.user.username || '管').charAt(0);
                if (nameEl) nameEl.textContent = state.user.username || '管理员';
            }
        }
    </script>
</body>
</html>`);
});

// /admin/ 重定向到 /admin
app.get('/admin/', (c) => {
    return c.redirect('/admin', 301);
});

// 用户中心页面
app.get('/user', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Teaven Pay - 用户中心</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/remixicon@4.9.1/fonts/remixicon.css">
    <script src="https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js"></script>
    <style>
        :root {
            --primary-50:#fffbeb;--primary-100:#fef3c7;--primary-200:#fde68a;--primary-300:#fcd34d;
            --primary-400:#fbbf24;--primary-500:#f59e0b;--primary-600:#d97706;--primary-700:#b45309;
            --success:#10b981;--warning:#f59e0b;--error:#ef4444;--info:#3b82f6;--default:#6b7280;
            --gray-50:#f9fafb;--gray-100:#f3f4f6;--gray-200:#e5e7eb;--gray-300:#d1d5db;
            --gray-400:#9ca3af;--gray-500:#6b7280;--gray-600:#4b5563;--gray-700:#374151;
            --gray-800:#1f2937;--gray-900:#111827;
            --bg-primary:#ffffff;--bg-secondary:#f9fafb;--bg-tertiary:#f3f4f6;
            --text-primary:#111827;--text-secondary:#4b5563;--text-tertiary:#9ca3af;
            --border-color:#e5e7eb;--shadow-sm:0 1px 2px 0 rgba(0,0,0,0.05);
            --shadow-md:0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -1px rgba(0,0,0,0.06);
            --sidebar-width:220px;--header-height:52px;
        }
        [data-theme="dark"] {
            --bg-primary:#111827;--bg-secondary:#1f2937;--bg-tertiary:#374151;
            --text-primary:#f9fafb;--text-secondary:#d1d5db;--text-tertiary:#9ca3af;
            --border-color:#374151;
        }
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg-secondary);color:var(--text-primary);}
        a{color:var(--primary-600);text-decoration:none;}
        .layout{display:flex;min-height:100vh;width:100%;}
        .sidebar{width:var(--sidebar-width);background:var(--bg-primary);border-right:1px solid var(--border-color);position:fixed;top:0;left:0;bottom:0;z-index:100;display:flex;flex-direction:column;}
        .sidebar-header{padding:16px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:10px;}
        .sidebar-header .logo{font-size:18px;font-weight:700;color:var(--primary-600);}
        .sidebar-nav{flex:1;padding:12px 8px;overflow-y:auto;}
        .nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;color:var(--text-secondary);cursor:pointer;font-size:14px;transition:all 0.15s;}
        .nav-item:hover{background:var(--bg-tertiary);color:var(--text-primary);}
        .nav-item.active{background:var(--primary-50);color:var(--primary-700);font-weight:600;}
        [data-theme="dark"] .nav-item.active{background:rgba(251,191,36,0.1);color:var(--primary-400);}
        .nav-item i{font-size:18px;width:20px;text-align:center;}
        .sidebar-footer{padding:12px 16px;border-top:1px solid var(--border-color);display:flex;align-items:center;gap:10px;font-size:13px;}
        .sidebar-footer .avatar{width:32px;height:32px;border-radius:50%;background:var(--primary-100);color:var(--primary-700);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;}
        .main-area{margin-left:var(--sidebar-width);flex:1;display:flex;flex-direction:column;}
        .header{height:var(--header-height);background:var(--bg-primary);border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:50;}
        .header-title{font-size:16px;font-weight:600;}
        .header-actions{display:flex;align-items:center;gap:12px;}
        .btn{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;border:none;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px;}
        .btn-primary{background:var(--primary-500);color:#fff;}.btn-primary:hover{background:var(--primary-600);}
        .btn-sm{padding:5px 10px;font-size:12px;}
        .btn-danger{background:var(--error);color:#fff;}.btn-danger:hover{opacity:0.9;}
        .btn-ghost{background:transparent;color:var(--text-secondary);border:1px solid var(--border-color);}.btn-ghost:hover{background:var(--bg-tertiary);}
        .main-content{flex:1;padding:24px;overflow-y:auto;}
        .card{background:var(--bg-primary);border:1px solid var(--border-color);border-radius:12px;margin-bottom:20px;}
        .card-header{padding:16px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;}
        .card-title{font-size:15px;font-weight:600;}
        .card-body{padding:20px;}
        .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px;}
        .stat-card{background:var(--bg-primary);border:1px solid var(--border-color);border-radius:12px;padding:18px 20px;}
        .stat-label{font-size:12px;color:var(--text-tertiary);margin-bottom:6px;}
        .stat-value{font-size:22px;font-weight:700;color:var(--text-primary);}
        .stat-sub{font-size:12px;color:var(--text-tertiary);margin-top:4px;}
        .table-container{overflow-x:auto;}
        table.data-table{width:100%;border-collapse:collapse;font-size:13px;}
        table.data-table th{text-align:left;padding:10px 14px;background:var(--bg-tertiary);color:var(--text-secondary);font-weight:600;white-space:nowrap;}
        table.data-table td{padding:10px 14px;border-bottom:1px solid var(--border-color);}
        table.data-table tr:hover{background:var(--bg-tertiary);}
        .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;}
        .badge-success{background:#d1fae5;color:#065f46;}.badge-warning{background:#fef3c7;color:#92400e;}
        .badge-error{background:#fee2e2;color:#991b1b;}.badge-default{background:var(--gray-100);color:var(--gray-600);}
        .badge-info{background:#dbeafe;color:#1e40af;}
        [data-theme="dark"] .badge-success{background:rgba(16,185,129,0.15);color:#6ee7b7;}
        [data-theme="dark"] .badge-warning{background:rgba(245,158,11,0.15);color:#fcd34d;}
        [data-theme="dark"] .badge-error{background:rgba(239,68,68,0.15);color:#fca5a5;}
        [data-theme="dark"] .badge-default{background:rgba(107,114,128,0.15);color:#9ca3af;}
        [data-theme="dark"] .badge-info{background:rgba(59,130,246,0.15);color:#93c5fd;}
        .form-group{margin-bottom:16px;}
        .form-label{display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:var(--text-secondary);}
        .form-input{width:100%;padding:8px 12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;background:var(--bg-primary);color:var(--text-primary);outline:none;transition:border-color 0.15s;}
        .form-input:focus{border-color:var(--primary-500);}
        textarea.form-input{resize:vertical;min-height:80px;}
        select.form-input{appearance:none;background-image:url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M2 5l6 6 6-6'/%3e%3c/svg%3e");background-repeat:no-repeat;background-position:right 8px center;background-size:12px;}
        .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
        .form-hint{font-size:12px;color:var(--text-tertiary);margin-top:4px;}
        .empty-state{text-align:center;padding:40px 20px;color:var(--text-tertiary);}
        .empty-state i{font-size:36px;margin-bottom:12px;display:block;}
        .pagination{display:flex;align-items:center;justify-content:space-between;margin-top:16px;font-size:13px;color:var(--text-secondary);}
        .pagination-btns{display:flex;gap:8px;}
        .page-container{display:none;}.page-container.active{display:block;}
        .login-container{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--bg-secondary);}
        .login-card{background:var(--bg-primary);border:1px solid var(--border-color);border-radius:16px;padding:40px;width:100%;max-width:400px;box-shadow:var(--shadow-md);}
        .login-logo{text-align:center;margin-bottom:32px;}.login-logo h1{font-size:24px;font-weight:700;color:var(--primary-600);}
        .login-logo p{font-size:13px;color:var(--text-tertiary);margin-top:4px;}
        .login-error{background:#fee2e2;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none;}
        .copy-btn{background:none;border:none;cursor:pointer;color:var(--primary-500);font-size:14px;padding:2px 6px;border-radius:4px;}
        .copy-btn:hover{background:var(--primary-50);}
        .chart-box{width:100%;height:260px;}
        .loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--text-tertiary);}
        .toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;z-index:9999;animation:slideIn 0.3s ease;box-shadow:var(--shadow-md);}
        .toast-success{background:#d1fae5;color:#065f46;}.toast-error{background:#fee2e2;color:#991b1b;}
        @keyframes slideIn{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:none;align-items:center;justify-content:center;}
        .modal-overlay.active{display:flex;}
        .modal{background:var(--bg-primary);border-radius:12px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-md);}
        .modal-header{padding:16px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;}
        .modal-title{font-size:16px;font-weight:600;}
        .modal-body{padding:20px;}.modal-footer{padding:12px 20px;border-top:1px solid var(--border-color);display:flex;justify-content:flex-end;gap:8px;}
        @media(max-width:768px){
            .sidebar{display:none;}.main-area{margin-left:0;}
            .stats-grid{grid-template-columns:1fr 1fr;}.form-row{grid-template-columns:1fr;}
            .header{padding:0 16px;}.main-content{padding:16px;}
        }
    </style>
</head>
<body>
    <div id="app"></div>
    <div class="modal-overlay" id="modalOverlay">
        <div class="modal" id="modalContent"></div>
    </div>
    <script>
    (function() {
        var urlParams = new URLSearchParams(window.location.search);
        var urlToken = urlParams.get('token');
        var token = urlToken || localStorage.getItem('merchant_token');
        if (urlToken) {
            localStorage.setItem('merchant_token', urlToken);
            urlParams.delete('token');
            var cleanQuery = urlParams.toString();
            window.history.replaceState(null, '', window.location.pathname + (cleanQuery ? '?' + cleanQuery : '') + window.location.hash);
        }
        var currentUser = null;
        var currentPage = 'dashboard';
        var app = document.getElementById('app');

        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function formatMoney(v) { return (Number(v) || 0).toFixed(2); }

        function formatDate(s) {
            if (!s) return '-';
            return s.replace('T', ' ').substring(0, 19);
        }

        function showToast(msg, type) {
            var el = document.createElement('div');
            el.className = 'toast toast-' + (type || 'success');
            el.textContent = msg;
            document.body.appendChild(el);
            setTimeout(function() { el.remove(); }, 3000);
        }

        function showModal(title, bodyHtml, footerHtml) {
            document.getElementById('modalContent').innerHTML =
                '<div class="modal-header"><span class="modal-title">' + title + '</span><button onclick="document.getElementById(\\'modalOverlay\\').classList.remove(\\'active\\')" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-tertiary)">&times;</button></div>' +
                '<div class="modal-body">' + bodyHtml + '</div>' +
                (footerHtml ? '<div class="modal-footer">' + footerHtml + '</div>' : '');
            document.getElementById('modalOverlay').classList.add('active');
        }

        function closeModal() { document.getElementById('modalOverlay').classList.remove('active'); }

        async function api(method, path, body) {
            var opts = { method: method, headers: { 'Authorization': 'Bearer ' + token } };
            if (body && !(body instanceof URLSearchParams)) {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(body);
            } else if (body) {
                opts.body = body;
            }
            var res = await fetch('/api/merchant' + path, opts);
            if (res.status === 401 || res.status === 403) {
                var data = await res.json().catch(function() { return {}; });
                if (data.code === -2) { logout(); return null; }
            }
            return res.json();
        }

        function getStatusBadge(status, type) {
            if (type === 'order') {
                var m = { 0: ['未支付','default'], 1: ['已支付','success'], 2: ['已退款','warning'], 3: ['已关闭','error'] };
                var s = m[status] || ['未知','default'];
                return '<span class="badge badge-' + s[1] + '">' + s[0] + '</span>';
            }
            if (type === 'settle') {
                var m2 = { 0: ['待处理','warning'], 1: ['处理中','info'], 2: ['已处理','success'], 3: ['已拒绝','error'] };
                var s2 = m2[status] || ['未知','default'];
                return '<span class="badge badge-' + s2[1] + '">' + s2[0] + '</span>';
            }
            if (type === 'refund') {
                var m3 = { 0: ['处理中','warning'], 1: ['成功','success'], 2: ['失败','error'] };
                var s3 = m3[status] || ['未知','default'];
                return '<span class="badge badge-' + s3[1] + '">' + s3[0] + '</span>';
            }
            return '<span class="badge badge-default">' + status + '</span>';
        }

        function renderLogin() {
            app.innerHTML =
                '<div class="login-container"><div class="login-card">' +
                '<div class="login-logo"><h1>Teaven Pay</h1><p>商户用户中心</p></div>' +
                '<div class="login-error" id="loginError"></div>' +
                '<div class="form-group"><label class="form-label">用户名 / 邮箱</label><input type="text" class="form-input" id="loginUsername" placeholder="请输入用户名或邮箱"></div>' +
                '<div class="form-group"><label class="form-label">密码</label><input type="password" class="form-input" id="loginPassword" placeholder="请输入密码"></div>' +
                '<div class="form-group"><button class="btn btn-primary" style="width:100%;justify-content:center;padding:10px;" id="loginBtn">登录</button></div>' +
                '</div></div>';
            document.getElementById('loginBtn').onclick = doLogin;
            document.getElementById('loginPassword').onkeydown = function(e) { if (e.key === 'Enter') doLogin(); };
        }

        async function doLogin() {
            var username = document.getElementById('loginUsername').value.trim();
            var password = document.getElementById('loginPassword').value;
            var errEl = document.getElementById('loginError');
            if (!username || !password) { errEl.textContent = '请输入用户名和密码'; errEl.style.display = 'block'; return; }
            errEl.style.display = 'none';
            document.getElementById('loginBtn').textContent = '登录中...';
            document.getElementById('loginBtn').disabled = true;
            try {
                var body = new URLSearchParams();
                body.set('username', username);
                body.set('password', password);
                var res = await fetch('/api/merchant/login', { method: 'POST', body: body });
                var data = await res.json();
                if (data.code === 0) {
                    token = data.data.token;
                    localStorage.setItem('merchant_token', token);
                    currentUser = data.data.user;
                    renderApp();
                } else {
                    errEl.textContent = data.msg || '登录失败';
                    errEl.style.display = 'block';
                }
            } catch (e) {
                errEl.textContent = '网络错误'; errEl.style.display = 'block';
            }
            document.getElementById('loginBtn').textContent = '登录';
            document.getElementById('loginBtn').disabled = false;
        }

        function logout() {
            token = null;
            currentUser = null;
            localStorage.removeItem('merchant_token');
            renderLogin();
        }

        async function renderApp() {
            if (!token) { renderLogin(); return; }
            app.innerHTML =
                '<div class="layout">' +
                '<aside class="sidebar">' +
                '<div class="sidebar-header"><i class="ri-wallet-3-line" style="font-size:22px;color:var(--primary-500)"></i><span class="logo">用户中心</span></div>' +
                '<nav class="sidebar-nav">' +
                '<div class="nav-item" data-page="dashboard"><i class="ri-dashboard-line"></i><span>仪表盘</span></div>' +
                '<div class="nav-item" data-page="orders"><i class="ri-receipt-line"></i><span>订单管理</span></div>' +
                '<div class="nav-item" data-page="settlements"><i class="ri-wallet-line"></i><span>结算管理</span></div>' +
                '<div class="nav-item" data-page="refunds"><i class="ri-refund-line"></i><span>退款管理</span></div>' +
                '<div class="nav-item" data-page="developer"><i class="ri-code-line"></i><span>接口配置</span></div>' +
                '<div class="nav-item" data-page="domains"><i class="ri-global-line"></i><span>域名白名单</span></div>' +
                '<div class="nav-item" data-page="cashierlink"><i class="ri-links-line"></i><span>收银台链接</span></div>' +
                '<div class="nav-item" data-page="settings"><i class="ri-settings-3-line"></i><span>账户设置</span></div>' +
                '</nav>' +
                '<div class="sidebar-footer"><div class="avatar" id="userAvatar">-</div><div style="flex:1;min-width:0;"><div id="userName" style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">-</div><div id="userId" style="font-size:11px;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">-</div></div><button class="btn btn-sm btn-ghost" onclick="window._userLogout()" title="退出"><i class="ri-logout-box-r-line"></i></button></div>' +
                '</aside>' +
                '<div class="main-area">' +
                '<header class="header"><span class="header-title" id="pageTitle">仪表盘</span><div class="header-actions"><button class="btn btn-sm btn-ghost" onclick="toggleTheme()" title="切换主题"><i class="ri-moon-line" id="themeIcon"></i></button></div></header>' +
                '<main class="main-content" id="pageContent"><div class="loading">加载中...</div></main>' +
                '</div></div>';

            window._userLogout = logout;

            document.querySelectorAll('.nav-item[data-page]').forEach(function(el) {
                el.onclick = function() { navigateTo(el.getAttribute('data-page')); };
            });

            await loadProfile();
            navigateTo('dashboard');
        }

        async function loadProfile() {
            var data = await api('GET', '/profile');
            if (!data || data.code !== 0) return;
            currentUser = data.data;
            var avatar = currentUser.username ? currentUser.username.charAt(0).toUpperCase() : '-';
            document.getElementById('userAvatar').textContent = avatar;
            document.getElementById('userName').textContent = currentUser.username || '-';
            document.getElementById('userId').textContent = 'ID: ' + (currentUser.id || '').substring(0, 8) + '...';
        }

        function navigateTo(page) {
            currentPage = page;
            document.querySelectorAll('.nav-item').forEach(function(el) {
                el.classList.toggle('active', el.getAttribute('data-page') === page);
            });
            var titles = { dashboard:'仪表盘', orders:'订单管理', settlements:'结算管理', refunds:'退款管理', developer:'接口配置', domains:'域名白名单', cashierlink:'收银台链接', settings:'账户设置' };
            document.getElementById('pageTitle').textContent = titles[page] || page;
            var loaders = { dashboard: loadDashboard, orders: loadOrders, settlements: loadSettlements, refunds: loadRefunds, developer: loadDeveloper, domains: loadDomains, cashierlink: loadCashierLink, settings: loadSettings };
            if (loaders[page]) loaders[page]();
        }

        function toggleTheme() {
            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
            localStorage.setItem('user_theme', isDark ? '' : 'dark');
            document.getElementById('themeIcon').className = isDark ? 'ri-moon-line' : 'ri-sun-line';
        }

        async function loadDashboard() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/dashboard');
            if (!data || data.code !== 0) return;
            var d = data.data;

            var trendHtml = '<div class="card"><div class="card-header"><h3 class="card-title">近7日交易趋势</h3></div><div class="card-body"><div class="chart-box" id="trendChart"></div></div></div>';

            var recentOrdersHtml = '';
            if (d.recent_orders && d.recent_orders.length > 0) {
                recentOrdersHtml = '<table class="data-table"><thead><tr><th>订单号</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>';
                d.recent_orders.forEach(function(o) {
                    recentOrdersHtml += '<tr><td><code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:12px;">' + escapeHtml(o.id ? o.id.substring(0, 12) + '...' : '-') + '</code></td><td>' + formatMoney(o.amount) + '</td><td>' + getStatusBadge(o.status, 'order') + '</td><td style="font-size:12px;">' + formatDate(o.created_at) + '</td></tr>';
                });
                recentOrdersHtml += '</tbody></table>';
            } else {
                recentOrdersHtml = '<div class="empty-state"><i class="ri-receipt-line"></i><p>暂无订单</p></div>';
            }

            content.innerHTML =
                '<div class="stats-grid">' +
                '<div class="stat-card"><div class="stat-label">可用余额</div><div class="stat-value" style="color:var(--primary-600)">' + formatMoney(d.balance) + '</div></div>' +
                '<div class="stat-card"><div class="stat-label">冻结余额</div><div class="stat-value">' + formatMoney(d.frozen_balance) + '</div></div>' +
                '<div class="stat-card"><div class="stat-label">今日订单</div><div class="stat-value">' + (d.today_orders || 0) + '</div><div class="stat-sub">收入 ' + formatMoney(d.today_income) + '</div></div>' +
                '<div class="stat-card"><div class="stat-label">昨日订单</div><div class="stat-value">' + (d.yesterday_orders || 0) + '</div><div class="stat-sub">收入 ' + formatMoney(d.yesterday_income) + '</div></div>' +
                '<div class="stat-card"><div class="stat-label">累计订单</div><div class="stat-value">' + (d.total_orders || 0) + '</div></div>' +
                '<div class="stat-card"><div class="stat-label">累计收入</div><div class="stat-value">' + formatMoney(d.total_income) + '</div></div>' +
                '</div>' +
                trendHtml +
                '<div class="card"><div class="card-header"><h3 class="card-title">最近订单</h3></div><div class="card-body" style="padding:0;"><div class="table-container">' + recentOrdersHtml + '</div></div></div>';

            if (d.trend && d.trend.length > 0 && typeof echarts !== 'undefined') {
                var chartDom = document.getElementById('trendChart');
                if (chartDom) {
                    var chart = echarts.init(chartDom);
                    chart.setOption({
                        tooltip: { trigger: 'axis' },
                        grid: { left: 50, right: 20, top: 20, bottom: 30 },
                        xAxis: { type: 'category', data: d.trend.map(function(t) { return t.date.substring(5); }), axisLabel: { fontSize: 11 } },
                        yAxis: { type: 'value', axisLabel: { fontSize: 11 } },
                        series: [{ data: d.trend.map(function(t) { return t.amount; }), type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#f59e0b' } }]
                    });
                }
            }
        }

        var ordersState = { offset: 0, limit: 20 };

        async function loadOrders() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var params = '?limit=' + ordersState.limit + '&offset=' + ordersState.offset;
            var status = document.getElementById('orderStatusFilter') ? document.getElementById('orderStatusFilter').value : '';
            if (status !== '') params += '&status=' + status;
            var data = await api('GET', '/orders' + params);
            if (!data || data.code !== 0) return;
            var d = data.data;
            var total = d.total || 0;
            var list = d.list || [];

            var html =
                '<div class="card"><div class="card-header"><h3 class="card-title">订单列表</h3>' +
                '<div style="display:flex;gap:8px;align-items:center;">' +
                '<select class="form-input" style="width:auto;padding:5px 10px;font-size:12px;" id="orderStatusFilter" onchange="window._reloadOrders()">' +
                '<option value="">全部状态</option><option value="0">未支付</option><option value="1">已支付</option><option value="2">已退款</option><option value="3">已关闭</option>' +
                '</select></div></div><div class="card-body" style="padding:0;"><div class="table-container"><table class="data-table"><thead><tr>' +
                '<th>订单号</th><th>商户订单号</th><th>商品</th><th>支付方式</th><th>金额</th><th>状态</th><th>创建时间</th><th>操作</th>' +
                '</tr></thead><tbody>';

            if (list.length === 0) {
                html += '<tr><td colspan="8"><div class="empty-state"><i class="ri-receipt-line"></i><p>暂无订单</p></div></td></tr>';
            } else {
                list.forEach(function(o) {
                    var actions = '';
                    if (o.status === 0) {
                        actions = '<button class="btn btn-sm btn-ghost" onclick="window._closeOrder(\\'' + o.id + '\\')">关闭</button>';
                    }
                    html += '<tr>' +
                        '<td><code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:11px;">' + escapeHtml(o.id ? o.id.substring(0, 12) + '...' : '-') + '</code></td>' +
                        '<td>' + escapeHtml(o.out_trade_no) + '</td>' +
                        '<td>' + escapeHtml(o.name || '-') + '</td>' +
                        '<td>' + escapeHtml(o.type_name || o.payment_type) + '</td>' +
                        '<td>' + formatMoney(o.amount) + '</td>' +
                        '<td>' + getStatusBadge(o.status, 'order') + '</td>' +
                        '<td style="font-size:12px;">' + formatDate(o.created_at) + '</td>' +
                        '<td>' + actions + '</td></tr>';
                });
            }

            html += '</tbody></table></div></div>';
            html += '<div class="pagination" style="padding:12px 20px;"><span>共 ' + total + ' 条</span><div class="pagination-btns">';
            if (ordersState.offset > 0) {
                html += '<button class="btn btn-sm btn-ghost" onclick="window._ordersPrev()">上一页</button>';
            }
            if (ordersState.offset + ordersState.limit < total) {
                html += '<button class="btn btn-sm btn-ghost" onclick="window._ordersNext()">下一页</button>';
            }
            html += '</div></div></div>';

            content.innerHTML = html;
            if (status !== '') document.getElementById('orderStatusFilter').value = status;

            window._reloadOrders = function() { ordersState.offset = 0; loadOrders(); };
            window._ordersPrev = function() { ordersState.offset = Math.max(0, ordersState.offset - ordersState.limit); loadOrders(); };
            window._ordersNext = function() { ordersState.offset += ordersState.limit; loadOrders(); };
            window._closeOrder = async function(id) {
                if (!confirm('确定关闭该订单？')) return;
                var res = await api('POST', '/orders/' + id + '/close');
                if (res && res.code === 0) { showToast('订单已关闭'); loadOrders(); }
                else if (res) showToast(res.msg || '操作失败', 'error');
            };
        }

        var settleState = { offset: 0, limit: 10 };

        async function loadSettlements() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/settle/list?limit=' + settleState.limit + '&offset=' + settleState.offset);
            if (!data || (data.code !== 0 && data.code !== 1)) return;
            var list = data.data || [];
            var total = data.count || 0;

            var html =
                '<div class="card"><div class="card-header"><h3 class="card-title">结算记录</h3>' +
                '<button class="btn btn-sm btn-primary" onclick="window._applySettle()"><i class="ri-add-line"></i>申请结算</button></div>' +
                '<div class="card-body" style="padding:0;"><div class="table-container"><table class="data-table"><thead><tr>' +
                '<th>结算ID</th><th>金额</th><th>结算方式</th><th>结算账号</th><th>状态</th><th>申请时间</th><th>处理时间</th>' +
                '</tr></thead><tbody>';

            if (list.length === 0) {
                html += '<tr><td colspan="7"><div class="empty-state"><i class="ri-wallet-line"></i><p>暂无结算记录</p></div></td></tr>';
            } else {
                list.forEach(function(s) {
                    html += '<tr>' +
                        '<td><code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:11px;">' + escapeHtml(s.id ? s.id.substring(0, 12) + '...' : '-') + '</code></td>' +
                        '<td>' + formatMoney(s.amount) + '</td>' +
                        '<td>' + escapeHtml(s.settle_type || '-') + '</td>' +
                        '<td>' + escapeHtml(s.settle_account || '-') + '</td>' +
                        '<td>' + getStatusBadge(s.status, 'settle') + '</td>' +
                        '<td style="font-size:12px;">' + formatDate(s.created_at) + '</td>' +
                        '<td style="font-size:12px;">' + formatDate(s.processed_at) + '</td></tr>';
                });
            }

            html += '</tbody></table></div></div>';
            html += '<div class="pagination" style="padding:12px 20px;"><span>共 ' + total + ' 条</span><div class="pagination-btns">';
            if (settleState.offset > 0) html += '<button class="btn btn-sm btn-ghost" onclick="window._settlePrev()">上一页</button>';
            if (settleState.offset + settleState.limit < total) html += '<button class="btn btn-sm btn-ghost" onclick="window._settleNext()">下一页</button>';
            html += '</div></div></div>';

            content.innerHTML = html;

            window._settlePrev = function() { settleState.offset = Math.max(0, settleState.offset - settleState.limit); loadSettlements(); };
            window._settleNext = function() { settleState.offset += settleState.limit; loadSettlements(); };
            window._applySettle = function() {
                var body =
                    '<div class="form-group"><label class="form-label">结算金额</label><input type="number" class="form-input" id="settleAmount" placeholder="请输入结算金额" step="0.01"></div>' +
                    '<div class="form-group"><label class="form-label">结算账号</label><input type="text" class="form-input" id="settleAccount" placeholder="留空则使用默认账号"></div>' +
                    '<div class="form-group"><label class="form-label">结算姓名</label><input type="text" class="form-input" id="settleName" placeholder="留空则使用默认姓名"></div>' +
                    '<div class="form-group"><label class="form-label">银行名称</label><input type="text" class="form-input" id="settleBank" placeholder="银行名称（可选）"></div>';
                var footer = '<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="window._submitSettle()">提交申请</button>';
                showModal('申请结算', body, footer);
            };
            window._submitSettle = async function() {
                var amount = document.getElementById('settleAmount').value;
                if (!amount || parseFloat(amount) <= 0) { showToast('请输入有效金额', 'error'); return; }
                var body = new URLSearchParams();
                body.set('amount', amount);
                var acc = document.getElementById('settleAccount').value;
                var name = document.getElementById('settleName').value;
                var bank = document.getElementById('settleBank').value;
                if (acc) body.set('settle_account', acc);
                if (name) body.set('settle_name', name);
                if (bank) body.set('bank_name', bank);
                var res = await api('POST', '/settle/apply', body);
                if (res && res.code === 0) { showToast('结算申请已提交'); closeModal(); loadSettlements(); }
                else if (res) showToast(res.msg || '操作失败', 'error');
            };
        }

        var refundState = { offset: 0, limit: 20 };

        async function loadRefunds() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/refunds?limit=' + refundState.limit + '&offset=' + refundState.offset);
            if (!data || data.code !== 0) return;
            var d = data.data;
            var total = d.total || 0;
            var list = d.list || [];

            var html =
                '<div class="card"><div class="card-header"><h3 class="card-title">退款记录</h3></div>' +
                '<div class="card-body" style="padding:0;"><div class="table-container"><table class="data-table"><thead><tr>' +
                '<th>退款单号</th><th>订单号</th><th>商品</th><th>金额</th><th>状态</th><th>原因</th><th>时间</th>' +
                '</tr></thead><tbody>';

            if (list.length === 0) {
                html += '<tr><td colspan="7"><div class="empty-state"><i class="ri-refund-line"></i><p>暂无退款记录</p></div></td></tr>';
            } else {
                list.forEach(function(r) {
                    html += '<tr>' +
                        '<td><code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:11px;">' + escapeHtml(r.refund_no ? r.refund_no.substring(0, 12) + '...' : '-') + '</code></td>' +
                        '<td><code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:11px;">' + escapeHtml(r.order_id ? r.order_id.substring(0, 12) + '...' : '-') + '</code></td>' +
                        '<td>' + escapeHtml(r.order_name || '-') + '</td>' +
                        '<td>' + formatMoney(r.amount) + '</td>' +
                        '<td>' + getStatusBadge(r.status, 'refund') + '</td>' +
                        '<td>' + escapeHtml(r.reason || '-') + '</td>' +
                        '<td style="font-size:12px;">' + formatDate(r.created_at) + '</td></tr>';
                });
            }

            html += '</tbody></table></div></div>';
            html += '<div class="pagination" style="padding:12px 20px;"><span>共 ' + total + ' 条</span><div class="pagination-btns">';
            if (refundState.offset > 0) html += '<button class="btn btn-sm btn-ghost" onclick="window._refundPrev()">上一页</button>';
            if (refundState.offset + refundState.limit < total) html += '<button class="btn btn-sm btn-ghost" onclick="window._refundNext()">下一页</button>';
            html += '</div></div></div>';

            content.innerHTML = html;
            window._refundPrev = function() { refundState.offset = Math.max(0, refundState.offset - refundState.limit); loadRefunds(); };
            window._refundNext = function() { refundState.offset += refundState.limit; loadRefunds(); };
        }

        async function loadDeveloper() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/profile');
            if (!data || data.code !== 0) return;
            var u = data.data;

            var maskedKey = u.api_key || '未设置';

            content.innerHTML =
                '<div class="card"><div class="card-header"><h3 class="card-title">接口信息</h3></div><div class="card-body">' +
                '<div class="form-group"><label class="form-label">商户 ID (PID)</label><div style="display:flex;align-items:center;gap:8px;"><code style="background:var(--bg-tertiary);padding:6px 12px;border-radius:6px;font-size:14px;flex:1;">' + escapeHtml(u.id) + '</code><button class="copy-btn" onclick="navigator.clipboard.writeText(\\'' + escapeHtml(u.id) + '\\');showToast(\\'已复制\\')"><i class="ri-file-copy-line"></i></button></div></div>' +
                '<div class="form-group"><label class="form-label">API Key</label><div style="display:flex;align-items:center;gap:8px;"><code style="background:var(--bg-tertiary);padding:6px 12px;border-radius:6px;font-size:14px;flex:1;word-break:break-all;">' + escapeHtml(maskedKey) + '</code><button class="btn btn-sm btn-danger" onclick="window._resetApiKey()"><i class="ri-refresh-line"></i>重置</button></div><div class="form-hint">重置后旧密钥立即失效，请谨慎操作</div></div>' +
                '</div></div>' +

                '<div class="card"><div class="card-header"><h3 class="card-title">签名配置</h3></div><div class="card-body">' +
                '<div class="form-group"><label class="form-label">签名方式</label><select class="form-input" id="devSignType" style="max-width:300px;"><option value="hmac-sha256">HMAC-SHA256</option><option value="md5">MD5</option><option value="rsa">RSA</option></select></div>' +
                '<div class="form-group" id="rsaKeyGroup" style="display:none;"><label class="form-label">RSA 公钥</label><textarea class="form-input" id="devRsaKey" placeholder="-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----">' + escapeHtml(u.rsa_public_key || '') + '</textarea></div>' +
                '<button class="btn btn-primary" onclick="window._saveSign()"><i class="ri-save-line"></i>保存签名配置</button>' +
                '</div></div>' +

                '<div class="card"><div class="card-header"><h3 class="card-title">回调配置</h3></div><div class="card-body">' +
                '<div class="form-group"><label class="form-label">默认异步通知地址 (notify_url)</label><input type="url" class="form-input" id="devNotifyUrl" placeholder="https://your-domain.com/notify" value="' + escapeHtml(u.notify_url || '') + '"></div>' +
                '<div class="form-group"><label class="form-label">默认同步跳转地址 (return_url)</label><input type="url" class="form-input" id="devReturnUrl" placeholder="https://your-domain.com/return" value="' + escapeHtml(u.return_url || '') + '"></div>' +
                '<button class="btn btn-primary" onclick="window._saveUrls()"><i class="ri-save-line"></i>保存回调配置</button>' +
                '</div></div>';

            document.getElementById('devSignType').value = u.api_key_type || 'hmac-sha256';
            document.getElementById('devSignType').onchange = function() {
                document.getElementById('rsaKeyGroup').style.display = this.value === 'rsa' ? 'block' : 'none';
            };
            if (u.api_key_type === 'rsa') document.getElementById('rsaKeyGroup').style.display = 'block';

            window._saveSign = async function() {
                var signType = document.getElementById('devSignType').value;
                var rsaKey = document.getElementById('devRsaKey').value;
                var body = new URLSearchParams();
                body.set('api_key_type', signType);
                if (signType === 'rsa') body.set('rsa_public_key', rsaKey);
                var res = await api('PUT', '/developer/signature', body);
                if (res && res.code === 0) showToast('签名配置已保存');
                else if (res) showToast(res.msg || '保存失败', 'error');
            };
            window._saveUrls = async function() {
                var body = new URLSearchParams();
                body.set('notify_url', document.getElementById('devNotifyUrl').value);
                body.set('return_url', document.getElementById('devReturnUrl').value);
                var res = await api('PUT', '/developer/urls', body);
                if (res && res.code === 0) showToast('回调配置已保存');
                else if (res) showToast(res.msg || '保存失败', 'error');
            };
            window._resetApiKey = function() {
                showModal('重置 API Key',
                    '<p style="margin-bottom:16px;color:var(--error);font-size:13px;">重置后旧密钥将立即失效，所有使用旧密钥的接口调用将无法正常工作。</p>' +
                    '<div class="form-group"><label class="form-label">请输入当前登录密码确认</label><input type="password" class="form-input" id="resetPwd" placeholder="当前密码"></div>',
                    '<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="window._confirmResetApiKey()">确认重置</button>'
                );
            };
            window._confirmResetApiKey = async function() {
                var pwd = document.getElementById('resetPwd').value;
                if (!pwd) { showToast('请输入密码', 'error'); return; }
                var body = new URLSearchParams();
                body.set('password', pwd);
                var res = await api('POST', '/developer/api-key/reset', body);
                if (res && res.code === 0) {
                    showToast('API Key 已重置，请妥善保管');
                    closeModal();
                    loadDeveloper();
                } else if (res) {
                    showToast(res.msg || '重置失败', 'error');
                }
            };
        }

        var domainState = { newDomain: '' };

        async function loadDomains() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/domains');
            if (!data || data.code !== 0) return;
            var list = data.data || [];

            var html =
                '<div class="card"><div class="card-header"><h3 class="card-title">域名白名单</h3>' +
                '<button class="btn btn-sm btn-primary" onclick="window._addDomain()"><i class="ri-add-line"></i>添加域名</button></div>' +
                '<div class="card-body">';

            if (list.length === 0) {
                html += '<div class="empty-state"><i class="ri-global-line"></i><p>暂未添加任何域名</p><p style="font-size:12px;margin-top:4px;">添加域名后，支付请求必须来自白名单域名</p></div>';
            } else {
                html += '<div class="table-container"><table class="data-table"><thead><tr><th>域名</th><th>状态</th><th>添加时间</th><th>操作</th></tr></thead><tbody>';
                list.forEach(function(d) {
                    html += '<tr>' +
                        '<td>' + escapeHtml(d.domain) + '</td>' +
                        '<td>' + (d.status === 1 ? '<span class="badge badge-success">启用</span>' : '<span class="badge badge-default">禁用</span>') + '</td>' +
                        '<td style="font-size:12px;">' + formatDate(d.created_at) + '</td>' +
                        '<td><button class="btn btn-sm btn-danger" onclick="window._deleteDomain(' + d.id + ')"><i class="ri-delete-bin-line"></i></button></td></tr>';
                });
                html += '</tbody></table></div>';
            }

            html += '</div></div>';
            content.innerHTML = html;

            window._addDomain = function() {
                showModal('添加域名',
                    '<div class="form-group"><label class="form-label">域名</label><input type="text" class="form-input" id="newDomain" placeholder="example.com（不含协议和路径）"></div>',
                    '<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="window._submitDomain()">添加</button>'
                );
            };
            window._submitDomain = async function() {
                var domain = document.getElementById('newDomain').value.trim();
                if (!domain) { showToast('请输入域名', 'error'); return; }
                var body = new URLSearchParams();
                body.set('domain', domain);
                var res = await api('POST', '/domains', body);
                if (res && res.code === 0) { showToast('添加成功'); closeModal(); loadDomains(); }
                else if (res) showToast(res.msg || '添加失败', 'error');
            };
            window._deleteDomain = async function(id) {
                if (!confirm('确定删除该域名？')) return;
                var res = await api('DELETE', '/domains/' + id);
                if (res && res.code === 0) { showToast('删除成功'); loadDomains(); }
                else if (res) showToast(res.msg || '删除失败', 'error');
            };
        }

        async function loadCashierLink() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/profile');
            if (!data || data.code !== 0) return;
            var u = data.data;
            var baseUrl = window.location.origin;
            var cashierUrl = baseUrl + '/pay/' + u.id;

            content.innerHTML =
                '<div class="card"><div class="card-header"><h3 class="card-title">收银台链接</h3></div><div class="card-body">' +
                '<p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">将此链接分享给客户，客户打开后可输入金额并选择支付方式直接付款。</p>' +
                '<div class="form-group"><label class="form-label">您的收银台链接</label>' +
                '<div style="display:flex;align-items:center;gap:8px;"><input type="text" class="form-input" id="cashierUrlInput" value="' + escapeHtml(cashierUrl) + '" readonly style="flex:1;font-size:14px;">' +
                '<button class="btn btn-primary" onclick="navigator.clipboard.writeText(document.getElementById(\\'cashierUrlInput\\').value);showToast(\\'链接已复制\\')"><i class="ri-file-copy-line"></i>复制</button></div></div>' +
                '<div style="margin-top:16px;padding:16px;background:var(--bg-tertiary);border-radius:8px;">' +
                '<div style="font-size:13px;font-weight:600;margin-bottom:8px;">使用说明</div>' +
                '<ul style="font-size:12px;color:var(--text-secondary);padding-left:18px;line-height:2;">' +
                '<li>客户打开链接后可输入付款金额</li>' +
                '<li>客户可选择支付宝、微信等支付方式</li>' +
                '<li>支付成功后资金将进入您的商户余额</li>' +
                '<li>可在「订单管理」中查看收银台产生的订单</li>' +
                '</ul></div>' +
                '</div></div>';
        }

        async function loadSettings() {
            var content = document.getElementById('pageContent');
            content.innerHTML = '<div class="loading">加载中...</div>';
            var data = await api('GET', '/profile');
            if (!data || data.code !== 0) return;
            var u = data.data;

            content.innerHTML =
                '<div class="card"><div class="card-header"><h3 class="card-title">基本信息</h3></div><div class="card-body">' +
                '<div class="form-row">' +
                '<div class="form-group"><label class="form-label">邮箱</label><input type="email" class="form-input" id="setEmail" value="' + escapeHtml(u.email || '') + '"></div>' +
                '<div class="form-group"><label class="form-label">手机号</label><input type="tel" class="form-input" id="setPhone" value="' + escapeHtml(u.contact_phone || '') + '"></div>' +
                '</div>' +
                '<div class="form-row">' +
                '<div class="form-group"><label class="form-label">联系 QQ</label><input type="text" class="form-input" id="setQQ" value="' + escapeHtml(u.contact_qq || '') + '"></div>' +
                '<div class="form-group"><label class="form-label">联系微信</label><input type="text" class="form-input" id="setWechat" value="' + escapeHtml(u.contact_wechat || '') + '"></div>' +
                '</div>' +
                '<button class="btn btn-primary" onclick="window._saveProfile()"><i class="ri-save-line"></i>保存信息</button>' +
                '</div></div>' +

                '<div class="card"><div class="card-header"><h3 class="card-title">结算信息</h3></div><div class="card-body">' +
                '<div class="form-group"><label class="form-label">结算方式</label><select class="form-input" id="setSettleType" style="max-width:300px;"><option value="alipay">支付宝</option><option value="bank">银行卡</option><option value="wechat">微信</option></select></div>' +
                '<div class="form-row">' +
                '<div class="form-group"><label class="form-label">结算账号</label><input type="text" class="form-input" id="setSettleAccount" value="' + escapeHtml(u.settle_account || '') + '"></div>' +
                '<div class="form-group"><label class="form-label">结算姓名</label><input type="text" class="form-input" id="setSettleName" value="' + escapeHtml(u.settle_name || '') + '"></div>' +
                '</div>' +
                '<button class="btn btn-primary" onclick="window._saveSettle()"><i class="ri-save-line"></i>保存结算信息</button>' +
                '</div></div>' +

                '<div class="card"><div class="card-header"><h3 class="card-title">修改密码</h3></div><div class="card-body">' +
                '<div class="form-group"><label class="form-label">当前密码</label><input type="password" class="form-input" id="setOldPwd" style="max-width:300px;"></div>' +
                '<div class="form-group"><label class="form-label">新密码</label><input type="password" class="form-input" id="setNewPwd" style="max-width:300px;"><div class="form-hint">不少于 6 位</div></div>' +
                '<button class="btn btn-primary" onclick="window._changePwd()"><i class="ri-lock-line"></i>修改密码</button>' +
                '</div></div>' +

                '<div class="card"><div class="card-header"><h3 class="card-title">登录信息</h3></div><div class="card-body">' +
                '<div class="form-row">' +
                '<div class="form-group"><label class="form-label">最后登录时间</label><div style="padding:8px 0;font-size:14px;">' + formatDate(u.last_login_at) + '</div></div>' +
                '<div class="form-group"><label class="form-label">最后登录 IP</label><div style="padding:8px 0;font-size:14px;">' + escapeHtml(u.last_login_ip || '-') + '</div></div>' +
                '</div></div></div>';

            document.getElementById('setSettleType').value = u.settle_type || 'alipay';

            window._saveProfile = async function() {
                var body = new URLSearchParams();
                body.set('email', document.getElementById('setEmail').value);
                body.set('contact_phone', document.getElementById('setPhone').value);
                body.set('contact_qq', document.getElementById('setQQ').value);
                body.set('contact_wechat', document.getElementById('setWechat').value);
                var res = await api('PUT', '/profile', body);
                if (res && res.code === 0) showToast('信息已保存');
                else if (res) showToast(res.msg || '保存失败', 'error');
            };
            window._saveSettle = async function() {
                var body = new URLSearchParams();
                body.set('settle_type', document.getElementById('setSettleType').value);
                body.set('settle_account', document.getElementById('setSettleAccount').value);
                body.set('settle_name', document.getElementById('setSettleName').value);
                var res = await api('PUT', '/profile', body);
                if (res && res.code === 0) showToast('结算信息已保存');
                else if (res) showToast(res.msg || '保存失败', 'error');
            };
            window._changePwd = async function() {
                var oldPwd = document.getElementById('setOldPwd').value;
                var newPwd = document.getElementById('setNewPwd').value;
                if (!oldPwd || !newPwd) { showToast('请输入当前密码和新密码', 'error'); return; }
                if (newPwd.length < 6) { showToast('新密码长度不能少于6位', 'error'); return; }
                var body = new URLSearchParams();
                body.set('old_password', oldPwd);
                body.set('new_password', newPwd);
                var res = await api('POST', '/password', body);
                if (res && res.code === 0) {
                    showToast('密码已修改，请重新登录');
                    setTimeout(logout, 1500);
                } else if (res) {
                    showToast(res.msg || '修改失败', 'error');
                }
            };
        }

        // 初始化主题
        var savedTheme = localStorage.getItem('user_theme');
        if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

        // 初始化
        renderApp();
    })();
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
