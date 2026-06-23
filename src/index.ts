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
    origin: (origin, c) => {
        // 允许的域名列表
        const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(',') || ['*'];
        if (allowedOrigins.includes('*')) return origin;
        return allowedOrigins.includes(origin) ? origin : '';
    },
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
