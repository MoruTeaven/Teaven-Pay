# Teaven Pay 部署指南

## 前置条件

1. **Cloudflare 账号** - 需要开启 Workers 计划
2. **Node.js 18+** - 用于本地开发和构建
3. **Wrangler CLI** - Cloudflare Workers 命令行工具
4. **Git** - 版本控制

---

## 一、环境准备

### 1.1 安装 Node.js

访问 https://nodejs.org 下载并安装 Node.js 18+ 版本。

```bash
# 验证安装
node --version
npm --version
```

### 1.2 安装 Wrangler CLI

```bash
npm install -g wrangler

# 验证安装
wrangler --version
```

### 1.3 登录 Cloudflare

```bash
wrangler login
```

浏览器会打开 Cloudflare 授权页面，完成授权后即可。

---

## 二、项目初始化

### 2.1 克隆项目

```bash
git clone https://github.com/your-username/teaven-pay.git
cd teaven-pay
```

### 2.2 安装依赖

```bash
# 后端依赖
cd workers
npm install

# 前端依赖
cd ../frontend
npm install
```

---

## 三、创建 Cloudflare 资源

### 3.1 创建 D1 数据库

```bash
cd workers

# 创建数据库
wrangler d1 create teaven-pay-db

# 输出示例:
# ✅ Successfully created DB 'teaven-pay-db'
# [[d1_databases]]
# binding = "DB"
# database_name = "teaven-pay-db"
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

将输出的 `database_id` 填入 `wrangler.toml` 配置文件。

### 3.2 创建 KV 命名空间

```bash
# 创建 KV 命名空间
wrangler kv:namespace create CACHE

# 输出示例:
# ✨ Successfully created KV namespace with ID "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 创建预览环境的 KV 命名空间
wrangler kv:namespace create CACHE --preview

# 输出示例:
# ✨ Successfully created KV namespace with ID "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

将输出的 KV ID 填入 `wrangler.toml` 配置文件。

### 3.3 创建 R2 存储桶 (可选)

```bash
# 创建 R2 存储桶
wrangler r2 bucket create teaven-pay-storage
```

---

## 四、配置项目

### 4.1 配置 wrangler.toml

```toml
name = "teaven-pay"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"
DEFAULT_CURRENCY = "CNY"

[[d1_databases]]
binding = "DB"
database_name = "teaven-pay-db"
database_id = "your-database-id"
preview_database_id = "your-preview-database-id"

[[kv_namespaces]]
binding = "CACHE"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"

# 可选: R2 存储
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "teaven-pay-storage"

# 可选: 队列
[[queues.producers]]
binding = "NOTIFY_QUEUE"
queue = "teaven-pay-notify"

[[queues.consumers]]
queue = "teaven-pay-notify"
max_batch_size = 10
max_batch_timeout = 30
```

### 4.2 配置 Secrets

```bash
# 设置 JWT 密钥
wrangler secret put JWT_SECRET
# 输入一个随机字符串，例如: my-super-secret-jwt-key-12345

# 设置加密密钥
wrangler secret put ENCRYPTION_KEY
# 输入一个 32 位随机字符串

# 设置管理员默认密码
wrangler secret put ADMIN_PASSWORD
# 输入管理员密码
```

### 4.3 初始化数据库

```bash
# 执行数据库迁移
wrangler d1 execute teaven-pay-db --file=./migrations/0001_initial.sql

# 验证表创建
wrangler d1 execute teaven-pay-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

---

## 五、本地开发

### 5.1 启动本地开发服务器

```bash
cd workers

# 启动本地开发服务器
wrangler dev

# 输出示例:
# ⛅️ wrangler 3.x.x
# ------------------
# Listening on http://8787
# Starting local server...
```

### 5.2 本地开发配置

创建 `.dev.vars` 文件用于本地环境变量:

```
JWT_SECRET=dev-secret-key
ENCRYPTION_KEY=dev-encryption-key-32-chars!!
ADMIN_PASSWORD=admin123
```

### 5.3 测试 API

```bash
# 测试健康检查
curl http://localhost:8787/api/health

# 测试创建订单
curl -X POST http://localhost:8787/api.php?act=submit \
  -d "pid=1001" \
  -d "type=alipay" \
  -d "out_trade_no=TEST001" \
  -d "notify_url=https://example.com/notify" \
  -d "return_url=https://example.com/return" \
  -d "name=测试商品" \
  -d "money=10.00" \
  -d "sign=xxx"
```

---

## 六、部署

### 6.1 部署 Workers

```bash
cd workers

# 部署到生产环境
wrangler deploy

# 输出示例:
# ✨ Successfully published your script to
# https://teaven-pay.your-subdomain.workers.dev
```

### 6.2 配置自定义域名

1. 登录 Cloudflare Dashboard
2. 进入 Workers & Pages
3. 选择 teaven-pay
4. 点击 Settings -> Triggers -> Custom Domains
5. 添加自定义域名，例如 `pay.yourdomain.com`

### 6.3 部署前端

```bash
cd frontend

# 构建前端
npm run build

# 部署到 Cloudflare Pages
wrangler pages deploy dist --project-name=teaven-pay-frontend
```

或者通过 Git 集成自动部署:

1. 登录 Cloudflare Dashboard
2. 进入 Pages
3. 创建项目，连接 GitHub 仓库
4. 配置构建设置:
   - 构建命令: `cd frontend && npm run build`
   - 输出目录: `frontend/dist`

### 6.4 配置前端环境变量

在 Cloudflare Pages 项目设置中添加环境变量:

```
VITE_API_URL=https://pay.yourdomain.com
```

---

## 七、生产环境配置

### 7.1 安全配置

```toml
# wrangler.toml

[vars]
ENVIRONMENT = "production"
# 开启 CORS
ALLOWED_ORIGINS = "https://yourdomain.com,https://admin.yourdomain.com"
# 请求频率限制
RATE_LIMIT = "100"
RATE_LIMIT_WINDOW = "60"
```

### 7.2 日志配置

```toml
[vars]
LOG_LEVEL = "info"
ENABLE_ACCESS_LOG = "true"
```

### 7.3 监控配置

在 Cloudflare Dashboard 中配置:
1. Workers Analytics - 查看请求统计
2. Alerts - 设置错误率告警
3. Logpush - 推送日志到外部服务

---

## 八、数据库管理

### 8.1 备份数据库

```bash
# 导出数据库
wrangler d1 export teaven-pay-db --output=backup.sql

# 压缩备份
gzip backup.sql
```

### 8.2 恢复数据库

```bash
# 解压备份
gunzip backup.sql.gz

# 恢复数据库
wrangler d1 execute teaven-pay-db --file=backup.sql
```

### 8.3 数据库迁移

```bash
# 创建新的迁移文件
cat > migrations/0002_add_index.sql << 'EOF'
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
EOF

# 执行迁移
wrangler d1 execute teaven-pay-db --file=./migrations/0002_add_index.sql
```

---

## 九、故障排查

### 9.1 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 部署失败 | wrangler.toml 配置错误 | 检查配置文件语法 |
| 数据库连接失败 | database_id 错误 | 检查 D1 数据库 ID |
| KV 读写失败 | KV ID 错误 | 检查 KV 命名空间 ID |
| 签名验证失败 | 签名算法错误 | 检查签名实现 |
| 403 错误 | 权限配置错误 | 检查域名和 CORS 配置 |

### 9.2 查看日志

```bash
# 实时查看 Workers 日志
wrangler tail

# 过滤错误日志
wrangler tail --level error
```

### 9.3 调试模式

```bash
# 启动调试模式
wrangler dev --inspect

# 使用 Chrome DevTools 调试
# 打开 chrome://inspect
```

---

## 十、性能优化

### 10.1 缓存策略

```typescript
// 使用 KV 缓存频繁查询的数据
async function getCachedUser(userId: string) {
    const cacheKey = `user:${userId}`;
    let user = await env.CACHE.get(cacheKey, 'json');
    
    if (!user) {
        user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
            .bind(userId)
            .first();
        
        if (user) {
            await env.CACHE.put(cacheKey, JSON.stringify(user), {
                expirationTtl: 300 // 5 分钟
            });
        }
    }
    
    return user;
}
```

### 10.2 数据库优化

```sql
-- 创建索引
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_trade_no ON orders(trade_no);
CREATE INDEX idx_orders_out_trade_no ON orders(out_trade_no);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- 复合索引
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
```

### 10.3 请求优化

```typescript
// 使用 Durable Objects 进行请求去重
export class RateLimiter {
    private state: DurableObjectState;
    
    constructor(state: DurableObjectState) {
        this.state = state;
    }
    
    async fetch(request: Request) {
        const ip = request.headers.get('CF-Connecting-IP');
        const key = `rate:${ip}`;
        
        let count = await this.state.storage.get<number>(key) || 0;
        
        if (count >= 100) {
            return new Response('Rate limit exceeded', { status: 429 });
        }
        
        await this.state.storage.put(key, count + 1, {
            expirationTtl: 60
        });
        
        return new Response('OK');
    }
}
```

---

## 十一、监控和告警

### 11.1 配置告警

在 Cloudflare Dashboard 中配置:

1. **错误率告警**: 当错误率超过 5% 时发送通知
2. **延迟告警**: 当 P95 延迟超过 1s 时发送通知
3. **请求量告警**: 当请求量突增 200% 时发送通知

### 11.2 集成外部监控

```typescript
// 发送错误到 Sentry
async function reportError(error: Error, context: any) {
    await fetch('https://sentry.io/api/xxx/store/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Sentry-Auth': 'Sentry sentry_key=xxx'
        },
        body: JSON.stringify({
            message: error.message,
            stacktrace: error.stack,
            extra: context
        })
    });
}
```

---

## 十二、更新和维护

### 12.1 更新 Workers

```bash
# 拉取最新代码
git pull origin main

# 安装新依赖
cd workers && npm install

# 部署更新
wrangler deploy
```

### 12.2 回滚版本

```bash
# 查看部署历史
wrangler deployments list

# 回滚到指定版本
wrangler rollback [deployment-id]
```

### 12.3 维护模式

```toml
# wrangler.toml
[vars]
MAINTENANCE_MODE = "false"
```

```typescript
// 在中间件中检查维护模式
if (env.MAINTENANCE_MODE === 'true') {
    return new Response('System Maintenance', {
        status: 503,
        headers: {
            'Retry-After': '3600'
        }
    });
}
```

---

## 附录

### A. 环境变量清单

| 变量名 | 说明 | 示例 |
|--------|------|------|
| ENVIRONMENT | 运行环境 | production |
| DEFAULT_CURRENCY | 默认货币 | CNY |
| JWT_SECRET | JWT 密钥 | (secret) |
| ENCRYPTION_KEY | 加密密钥 | (secret) |
| ADMIN_PASSWORD | 管理员密码 | (secret) |
| ALLOWED_ORIGINS | 允许的域名 | https://yourdomain.com |
| RATE_LIMIT | 请求频率限制 | 100 |
| RATE_LIMIT_WINDOW | 限制窗口(秒) | 60 |
| LOG_LEVEL | 日志级别 | info |
| MAINTENANCE_MODE | 维护模式 | false |

### B. API 端点清单

| 端点 | 方法 | 说明 |
|------|------|------|
| /api/health | GET | 健康检查 |
| /submit.php | POST | 发起支付(同步) |
| /api.php?act=submit | POST | 发起支付(API) |
| /api.php?act=order | GET | 查询订单 |
| /api.php?act=orders | GET | 批量查询订单 |
| /api.php?act=query | GET | 查询商户信息 |
| /api.php?act=settle | GET | 查询结算记录 |
| /api.php?act=refund | POST | 申请退款 |
| /api.php?act=refundquery | GET | 查询退款记录 |
| /api.php?act=close | POST | 关闭订单 |

### C. 错误码清单

| 错误码 | 说明 |
|--------|------|
| 1 | 成功 |
| 0 | 失败 |
| -1 | 参数错误 |
| -2 | 签名验证失败 |
| -3 | 商户不存在或密钥错误 |
| -4 | 订单不存在 |
| -5 | 系统错误 |
