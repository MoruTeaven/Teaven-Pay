# Teaven Pay - Cloudflare Workers 易支付系统

基于 Cloudflare Workers 构建的高性能易支付聚合支付系统，完全兼容易支付标准接口。

---

## 技术架构

### 核心技术栈
- **运行时**: Cloudflare Workers
- **数据库**: Cloudflare D1 (SQLite)
- **缓存**: Cloudflare KV
- **前端**: Cloudflare Pages + Vue/React
- **语言**: TypeScript

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Workers    │  │    Pages     │  │     KV       │      │
│  │   (API)      │  │   (前端)     │  │   (缓存)     │      │
│  └──────┬───────┘  └──────────────┘  └──────────────┘      │
│         │                                                     │
│         ▼                                                     │
│  ┌──────────────┐                                            │
│  │     D1       │                                            │
│  │  (数据库)    │                                            │
│  └──────────────┘                                            │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 项目结构

```
teaven-pay/
├── workers/                    # Cloudflare Workers 后端
│   ├── src/
│   │   ├── index.ts           # 入口文件
│   │   ├── router.ts          # 路由
│   │   ├── api/               # API 接口
│   │   │   ├── pay.ts         # 支付接口
│   │   │   ├── order.ts       # 订单接口
│   │   │   ├── merchant.ts    # 商户接口
│   │   │   └── admin.ts       # 管理后台接口
│   │   ├── models/            # 数据模型
│   │   │   ├── user.ts        # 用户模型
│   │   │   ├── order.ts       # 订单模型
│   │   │   ├── payment.ts     # 支付方式模型
│   │   │   └── channel.ts     # 支付通道模型
│   │   ├── services/          # 业务逻辑
│   │   │   ├── payment.ts     # 支付服务
│   │   │   ├── signature.ts   # 签名验证
│   │   │   └── notify.ts      # 异步通知
│   │   ├── plugins/           # 支付插件
│   │   │   ├── alipay.ts      # 支付宝
│   │   │   ├── wxpay.ts       # 微信支付
│   │   │   ├── qqpay.ts       # QQ钱包
│   │   │   └── index.ts       # 插件管理
│   │   ├── utils/             # 工具函数
│   │   │   ├── crypto.ts      # 加密工具
│   │   │   ├── uuid.ts        # UUID v7
│   │   │   └── validator.ts   # 验证器
│   │   └── types/             # TypeScript 类型
│   │       └── index.ts
│   ├── wrangler.toml          # Workers 配置
│   └── package.json
│
├── frontend/                   # 前端项目
│   ├── src/
│   │   ├── views/
│   │   │   ├── admin/         # 管理后台
│   │   │   ├── merchant/      # 商户中心
│   │   │   └── cashier/       # 收银台
│   │   ├── components/
│   │   └── api/
│   └── package.json
│
├── docs/                       # 文档
│   ├── api.md                 # API 文档
│   ├── deploy.md              # 部署文档
│   └── plugin.md              # 插件开发文档
│
└── README.md
```

---

## 数据库设计 (D1)

### 用户表 (users)
```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,              -- UUID v7
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,      -- PBKDF2 77777次
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'merchant', -- admin/merchant
    status INTEGER DEFAULT 1,         -- 0禁用 1正常 2待审核
    balance REAL DEFAULT 0,           -- 余额
    api_key TEXT UNIQUE,              -- 商户密钥
    api_rsa_public TEXT,              -- RSA公钥
    notify_url TEXT,                  -- 异步通知地址
    return_url TEXT,                  -- 同步跳转地址
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
```

### 订单表 (orders)
```sql
CREATE TABLE orders (
    id TEXT PRIMARY KEY,              -- UUID v7 (trade_no)
    user_id TEXT NOT NULL,
    out_trade_no TEXT NOT NULL,       -- 商户订单号
    payment_type TEXT NOT NULL,       -- 支付方式 alipay/wxpay/qqpay
    channel_id TEXT,                  -- 支付通道
    amount REAL NOT NULL,             -- 订单金额
    actual_amount REAL,               -- 实际支付金额
    status INTEGER DEFAULT 0,         -- 0未支付 1已支付 2已退款 3已关闭
    name TEXT,                        -- 商品名称
    param TEXT,                       -- 自定义参数
    buyer TEXT,                       -- 买家信息
    notify_url TEXT,                  -- 异步通知地址
    notify_status INTEGER DEFAULT 0,  -- 通知状态 0未通知 1已通知
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 支付方式表 (payment_types)
```sql
CREATE TABLE payment_types (
    id TEXT PRIMARY KEY,              -- UUID v7
    name TEXT NOT NULL UNIQUE,        -- alipay/wxpay/qqpay
    display_name TEXT NOT NULL,       -- 显示名称
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    config TEXT,                      -- JSON配置
    created_at TEXT DEFAULT (datetime('now'))
);
```

### 支付通道表 (channels)
```sql
CREATE TABLE channels (
    id TEXT PRIMARY KEY,              -- UUID v7
    payment_type_id TEXT NOT NULL,    -- 关联支付方式
    name TEXT NOT NULL,               -- 通道名称
    plugin TEXT NOT NULL,             -- 插件标识
    config TEXT,                      -- JSON配置 (加密存储)
    fee_rate REAL DEFAULT 0,          -- 费率
    min_amount REAL DEFAULT 0,        -- 最小金额
    max_amount REAL DEFAULT 0,        -- 最大金额
    sort_order INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (payment_type_id) REFERENCES payment_types(id)
);
```

### 结算记录表 (settlements)
```sql
CREATE TABLE settlements (
    id TEXT PRIMARY KEY,              -- UUID v7
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    status INTEGER DEFAULT 0,         -- 0待处理 1已处理 2已拒绝
    bank_info TEXT,                   -- 银行信息 JSON
    created_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 退款记录表 (refunds)
```sql
CREATE TABLE refunds (
    id TEXT PRIMARY KEY,              -- UUID v7
    order_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    refund_no TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL,
    reason TEXT,
    status INTEGER DEFAULT 0,         -- 0处理中 1成功 2失败
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 操作日志表 (logs)
```sql
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

---

## API 接口文档

### 基础信息
- **Base URL**: `https://your-domain.com`
- **签名方式**: MD5 / RSA
- **响应格式**: JSON

### 签名算法

#### MD5 签名
```
sign = md5(pid + out_trade_no + type + name + money + notify_url + return_url + api_key)
```

#### RSA 签名
```
sign = rsa_sign(待签名字符串, 商户私钥)
待签名字符串 = 按参数名ASCII排序后拼接
```

---

### 1. 发起支付

**POST** `/api/pay/submit`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| type | string | 是 | 支付方式: alipay/wxpay/qqpay |
| out_trade_no | string | 是 | 商户订单号 |
| notify_url | string | 是 | 异步通知地址 |
| return_url | string | 是 | 同步跳转地址 |
| name | string | 是 | 商品名称 |
| money | number | 是 | 金额(元) |
| sign | string | 是 | 签名 |
| sign_type | string | 否 | 签名类型: MD5/RSA，默认MD5 |
| param | string | 否 | 自定义参数 |
| device | string | 否 | 设备类型: pc/mobile |

#### 响应参数
```json
{
    "code": 1,
    "msg": "创建订单成功",
    "trade_no": "202606221234567890",
    "payurl": "https://your-domain.com/pay/202606221234567890",
    "qrcode": "weixin://wxpay/bizpayurl?pr=xxxxx"
}
```

---

### 2. 查询订单

**GET** `/api/pay/query`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| trade_no | string | 否 | 平台订单号 |
| out_trade_no | string | 否 | 商户订单号 |
| sign | string | 是 | 签名 |
| sign_type | string | 否 | 签名类型 |

#### 响应参数
```json
{
    "code": 1,
    "trade_no": "202606221234567890",
    "out_trade_no": "ORDER_123456",
    "type": "alipay",
    "pid": "1001",
    "name": "商品名称",
    "money": "10.00",
    "status": 1,
    "addtime": "2026-06-22 12:00:00",
    "endtime": "2026-06-22 12:05:00",
    "param": "",
    "buyer": "买家账号"
}
```

---

### 3. 批量查询订单

**GET** `/api/pay/orders`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| limit | number | 否 | 每页数量，默认10，最大50 |
| offset | number | 否 | 偏移量 |
| status | number | 否 | 订单状态: 0未支付 1已支付 2已退款 3已关闭 |
| sign | string | 是 | 签名 |

#### 响应参数
```json
{
    "code": 1,
    "count": 100,
    "data": [
        {
            "trade_no": "202606221234567890",
            "out_trade_no": "ORDER_123456",
            "type": "alipay",
            "name": "商品名称",
            "money": "10.00",
            "status": 1,
            "addtime": "2026-06-22 12:00:00"
        }
    ]
}
```

---

### 4. 查询商户信息

**GET** `/api/merchant/query`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| key | string | 是 | 商户密钥 |
| sign | string | 是 | 签名 |

#### 响应参数
```json
{
    "code": 1,
    "pid": "1001",
    "username": "商户名称",
    "email": "merchant@example.com",
    "balance": 1000.00,
    "status": 1,
    "orders_today": 50,
    "orders_yesterday": 120,
    "total_orders": 5000
}
```

---

### 5. 申请结算

**POST** `/api/merchant/settle`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| amount | number | 是 | 结算金额 |
| bank_info | object | 是 | 银行信息 |
| sign | string | 是 | 签名 |

---

### 6. 查询结算记录

**GET** `/api/merchant/settle/list`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| limit | number | 否 | 每页数量 |
| offset | number | 否 | 偏移量 |
| sign | string | 是 | 签名 |

---

### 7. 申请退款

**POST** `/api/pay/refund`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| trade_no | string | 否 | 平台订单号 |
| out_trade_no | string | 否 | 商户订单号 |
| amount | number | 是 | 退款金额 |
| sign | string | 是 | 签名 |

---

### 8. 查询退款记录

**GET** `/api/pay/refund/query`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| refund_no | string | 否 | 退款单号 |
| out_trade_no | string | 否 | 商户订单号 |
| sign | string | 是 | 签名 |

---

### 9. 关闭订单

**POST** `/api/pay/close`

#### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | string | 是 | 商户ID |
| trade_no | string | 否 | 平台订单号 |
| out_trade_no | string | 否 | 商户订单号 |
| sign | string | 是 | 签名 |

---

### 10. 异步通知

支付成功后，系统会向商户提供的 `notify_url` 发送 POST 请求。

#### 通知参数
| 参数名 | 类型 | 说明 |
|--------|------|------|
| pid | string | 商户ID |
| trade_no | string | 平台订单号 |
| out_trade_no | string | 商户订单号 |
| type | string | 支付方式 |
| name | string | 商品名称 |
| money | number | 订单金额 |
| param | string | 自定义参数 |
| trade_status | string | 交易状态: TRADE_SUCCESS |
| sign | string | 签名 |
| sign_type | string | 签名类型 |

#### 商户响应
商户收到通知后，需要返回字符串 `success` 表示通知成功。系统会重复通知最多 5 次，间隔为 1分钟、5分钟、30分钟、1小时、6小时。

---

## 支付插件开发

### 插件接口

```typescript
interface PaymentPlugin {
    // 插件标识
    id: string;
    // 插件名称
    name: string;
    // 支持的支付方式
    paymentTypes: string[];
    
    // 发起支付
    createPayment(order: Order, config: PluginConfig): Promise<PaymentResult>;
    
    // 验证回调
    verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult>;
    
    // 查询订单
    queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderResult>;
    
    // 退款
    refund(order: Order, amount: number, config: PluginConfig): Promise<RefundResult>;
}
```

### 插件示例

```typescript
// plugins/alipay.ts
export class AlipayPlugin implements PaymentPlugin {
    id = 'alipay';
    name = '支付宝';
    paymentTypes = ['alipay'];
    
    async createPayment(order: Order, config: PluginConfig): Promise<PaymentResult> {
        // 实现支付宝下单逻辑
    }
    
    async verifyNotify(payload: any, config: PluginConfig): Promise<NotifyResult> {
        // 实现支付宝回调验证
    }
    
    async queryOrder(tradeNo: string, config: PluginConfig): Promise<OrderResult> {
        // 实现支付宝订单查询
    }
    
    async refund(order: Order, amount: number, config: PluginConfig): Promise<RefundResult> {
        // 实现支付宝退款
    }
}
```

---

## 支付方式

| 支付方式 | 标识 | 状态 |
|----------|------|------|
| 支付宝 | alipay | ✅ 已支持 |
| 微信支付 | wxpay | ✅ 已支持 |
| QQ钱包 | qqpay | ✅ 已支持 |
| 京东支付 | jdpay | 🚧 开发中 |
| 银联 | unionpay | 🚧 开发中 |
| USDT | usdt | 🚧 开发中 |

---

## 安全设计

### 1. 密码存储
- 使用 PBKDF2 算法，迭代次数 77777 次
- 每个用户独立 salt

### 2. 签名验证
- 支持 MD5 和 RSA 两种签名方式
- 所有 API 请求必须携带签名

### 3. 请求验证
- IP 白名单
- 请求频率限制
- 防重放攻击 (nonce + timestamp)

### 4. 数据安全
- 敏感配置使用 Cloudflare Workers Secrets
- 数据库字段加密存储
- HTTPS 强制

---

## 部署指南

### 前置条件
1. Cloudflare 账号
2. Node.js 18+
3. Wrangler CLI

### 部署步骤

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 D1 数据库
npx wrangler d1 create teaven-pay-db

# 4. 创建 KV 命名空间
npx wrangler kv:namespace create CACHE

# 5. 配置 wrangler.toml
# 填入数据库 ID 和 KV ID

# 6. 初始化数据库
npx wrangler d1 execute teaven-pay-db --file=./schema.sql

# 7. 部署 Workers
npx wrangler deploy

# 8. 部署前端 (可选)
# 使用 Cloudflare Pages 部署
```

### 环境变量

```toml
[vars]
ENVIRONMENT = "production"
DEFAULT_CURRENCY = "CNY"

# Secrets (使用 wrangler secret set)
# JWT_SECRET
# ENCRYPTION_KEY
```

---

## 开发计划

### Phase 1 - 核心功能 ✅
- [x] 项目架构设计
- [ ] 数据库设计
- [ ] 用户认证系统
- [ ] 基础支付接口

### Phase 2 - 支付插件
- [ ] 支付宝插件
- [ ] 微信支付插件
- [ ] QQ钱包插件

### Phase 3 - 管理功能
- [ ] 管理后台
- [ ] 商户中心
- [ ] 数据统计

### Phase 4 - 高级功能
- [ ] 风控系统
- [ ] 多语言支持
- [ ] API 文档自动生成

---

## 许可证

MIT License
