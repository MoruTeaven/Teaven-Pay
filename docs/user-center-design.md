# Teaven Pay 用户中心设计文档

## 一、概述

用户中心是 Teaven Pay 面向商户用户的前台面板。商户登录后可以查看账户余额、交易统计、订单记录、结算记录，维护 API 密钥、回调地址、结算资料和登录密码。

本文档先定义用户中心的业务范围、页面结构、接口约定和安全要求，后续实现以本文档为准。

### 目标

- 支持商户使用用户名或邮箱登录用户中心。
- 提供商户自助查看订单、余额、结算、接口配置的能力。
- 复用现有 `users`、`orders`、`settlements`、`refunds`、`domain_whitelist` 等数据表。
- 复用现有 JWT 认证机制，与管理员后台隔离权限。
- 保持易支付兼容 API 不受影响。

### 非目标

- 不在用户中心提供管理员能力，例如通道配置、商户审核、系统配置。
- 不在第一阶段实现多角色组织、子账号、复杂权限模型。
- 不改动现有易支付签名协议和支付回调协议。

## 二、命名与入口

### 用户定义

本文档中的“用户”指 `users.role = 'merchant'` 的商户账号。管理员账号仍通过管理后台登录，不进入用户中心。

### 页面入口

| 页面 | 路径 | 说明 |
|------|------|------|
| 用户中心 | `/user` | 商户登录后进入的用户面板 |
| 登录页 | `/user/login` | 未登录或登录失效时展示 |

### API 前缀

用户中心 API 继续使用当前代码中的商户路由前缀：

```text
/api/merchant/*
```

如后续需要更贴近“用户中心”命名，可新增 `/api/user/*` 作为别名，但不应破坏现有 `/api/merchant/*`。

## 三、账号与登录态

### 账号状态

| 状态 | 含义 | 用户中心行为 |
|------|------|--------------|
| `0` | 禁用 | 禁止登录，已登录用户请求返回未授权或账号禁用 |
| `1` | 正常 | 允许登录和使用用户中心 |
| `2` | 待审核 | 可以按配置决定是否允许登录，默认禁止发起支付和结算 |

第一阶段建议：`status !== 1` 时禁止登录，返回明确错误文案。

### 登录方式

- 用户输入 `username` 和 `password`。
- `username` 支持用户名或邮箱。
- 后端只查询 `role = 'merchant'` 的账号。
- 密码使用现有 PBKDF2 校验逻辑。
- 登录成功后签发 JWT，有效期默认 24 小时。
- 登录成功后更新 `last_login_at` 和 `last_login_ip`。

### Token 存储

- 前端将 JWT 保存在 `localStorage` 或 `sessionStorage`。
- 所有用户中心 API 请求携带 `Authorization: Bearer <token>`。
- 收到 HTTP `401`、`403` 或业务 `code = -2` 时清除本地登录态并跳转登录页。

## 四、页面信息架构

### 1. 登录页

路径：`/user/login`

功能：

- 用户名或邮箱输入。
- 密码输入。
- 登录按钮和错误提示。
- 登录成功后跳转 `/user`。

### 2. 仪表盘

路径：`/user/dashboard`

功能：

- 可用余额、冻结余额、今日收入、今日订单、累计收入、累计订单。
- 最近订单列表。
- 最近结算列表。
- 近 7 日交易趋势。
- 账户状态和接口状态提醒。

### 3. 订单管理

路径：`/user/orders`

功能：

- 订单列表、搜索、筛选、分页。
- 按平台订单号、商户订单号、支付方式、订单状态、时间范围查询。
- 查看订单详情。
- 对未支付订单执行关闭操作。
- 对已支付订单发起退款，是否开放由系统配置控制。

订单状态：

| 状态 | 含义 |
|------|------|
| `0` | 未支付 |
| `1` | 已支付 |
| `2` | 已退款 |
| `3` | 已关闭 |

### 4. 结算管理

路径：`/user/settlements`

功能：

- 查看结算记录。
- 申请结算。
- 展示最低结算金额、可用余额、冻结余额和预计手续费。
- 查看拒绝原因。

结算状态：

| 状态 | 含义 |
|------|------|
| `0` | 待处理 |
| `1` | 处理中 |
| `2` | 已处理 |
| `3` | 已拒绝 |

### 5. 退款管理

路径：`/user/refunds`

功能：

- 查看退款记录。
- 按退款单号、订单号、状态和时间筛选。
- 查看退款失败原因。

退款状态：

| 状态 | 含义 |
|------|------|
| `0` | 处理中 |
| `1` | 成功 |
| `2` | 失败 |

### 6. 接口配置

路径：`/user/developer`

功能：

- 查看商户 ID。
- 查看和复制 API Key。
- 重置 API Key，需要二次确认和当前密码验证。
- 选择签名类型：`hmac-sha256`、`md5`、`rsa`。
- 配置 RSA 公钥。
- 配置默认 `notify_url` 和 `return_url`。
- 查看易支付接口示例和签名说明。

### 7. 域名白名单

路径：`/user/domains`

功能：

- 查看当前商户域名白名单。
- 新增、删除、启用、禁用域名。
- 当系统配置 `enable_domain_whitelist = 1` 时，支付请求必须来自白名单域名。

### 8. 账户设置

路径：`/user/settings`

功能：

- 修改邮箱、QQ、微信、手机号。
- 修改默认结算方式、结算账号、结算姓名。
- 修改登录密码。
- 查看最近登录时间和 IP。

## 五、接口设计

### 通用响应

用户中心新接口统一返回 JSON：

```json
{
    "code": 0,
    "msg": "success",
    "data": {}
}
```

兼容已有接口时可以保留现有 `code = 1` 成功格式，但新接口优先使用 `code = 0` 表示业务成功，与现有管理员登录接口保持一致。

### 认证接口

#### 登录

`POST /api/merchant/login`

请求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `username` | string | 是 | 用户名或邮箱 |
| `password` | string | 是 | 登录密码 |

响应：

```json
{
    "code": 0,
    "msg": "登录成功",
    "data": {
        "token": "jwt-token",
        "user": {
            "id": "merchant-id",
            "username": "merchant",
            "email": "merchant@example.com",
            "role": "merchant",
            "status": 1
        }
    }
}
```

#### 当前登录用户

`GET /api/merchant/profile`

认证：需要 `Authorization: Bearer <token>`。

响应字段：

| 字段 | 说明 |
|------|------|
| `id` | 商户 ID |
| `username` | 用户名 |
| `email` | 邮箱 |
| `status` | 账号状态 |
| `balance` | 可用余额 |
| `frozen_balance` | 冻结余额 |
| `api_key_type` | 签名类型 |
| `notify_url` | 默认异步通知地址 |
| `return_url` | 默认同步跳转地址 |
| `settle_type` | 结算方式 |
| `settle_account` | 结算账号 |
| `settle_name` | 结算姓名 |
| `last_login_at` | 最后登录时间 |
| `last_login_ip` | 最后登录 IP |

#### 退出登录

`POST /api/merchant/logout`

第一阶段可只由前端清除 token；后端接口返回成功即可。若后续要服务端吊销 token，需要新增 token 黑名单或会话表。

### 仪表盘接口

#### 概览统计

`GET /api/merchant/dashboard`

认证：需要 Bearer Token。

响应：

```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "balance": 1000.0,
        "frozen_balance": 0.0,
        "today_orders": 10,
        "today_income": 200.0,
        "yesterday_orders": 8,
        "yesterday_income": 160.0,
        "total_orders": 500,
        "total_income": 12000.0,
        "trend": [
            { "date": "2026-06-22", "orders": 10, "amount": 200.0 }
        ],
        "recent_orders": [],
        "recent_settlements": []
    }
}
```

说明：当前 `GET /api/merchant/query` 已提供部分账户和今日、昨日统计，可先复用；后续新增 `dashboard` 返回更多聚合数据。

### 订单接口

#### 订单列表

`GET /api/merchant/orders`

认证：需要 Bearer Token。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | number | 否 | 每页数量，默认 20，最大 100 |
| `offset` | number | 否 | 偏移量，默认 0 |
| `status` | number | 否 | 订单状态 |
| `payment_type` | string | 否 | 支付方式 |
| `keyword` | string | 否 | 平台订单号、商户订单号、商品名称 |
| `start_time` | string | 否 | 创建开始时间 |
| `end_time` | string | 否 | 创建结束时间 |

#### 订单详情

`GET /api/merchant/orders/:id`

认证：需要 Bearer Token。

权限：只能访问当前商户自己的订单。

#### 关闭订单

`POST /api/merchant/orders/:id/close`

认证：需要 Bearer Token。

规则：仅 `status = 0` 的未支付订单允许关闭。

### 结算接口

#### 结算列表

`GET /api/merchant/settle/list`

说明：当前已存在，可继续作为用户中心结算列表接口。

#### 申请结算

`POST /api/merchant/settle/apply`

说明：当前已存在，可继续作为用户中心申请结算接口。

需要补充校验：

- 账号状态必须为正常。
- 金额必须大于 0 且不低于 `min_settle_amount`。
- 申请金额不能超过可用余额。
- 创建结算记录和冻结余额更新需要保证一致性，避免重复冻结。

### 退款接口

#### 退款列表

`GET /api/merchant/refunds`

认证：需要 Bearer Token。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | number | 否 | 每页数量，默认 20，最大 100 |
| `offset` | number | 否 | 偏移量，默认 0 |
| `status` | number | 否 | 退款状态 |
| `keyword` | string | 否 | 退款单号、平台订单号、商户订单号 |

#### 发起退款

`POST /api/merchant/orders/:id/refund`

认证：需要 Bearer Token。

规则：

- 订单必须属于当前商户。
- 订单必须为已支付状态。
- 退款金额不能超过订单可退金额。
- 重复请求不得重复退款，建议生成退款单号并按退款单号幂等处理。

### 接口配置接口

#### 更新回调配置

`PUT /api/merchant/developer/urls`

请求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `notify_url` | string | 否 | 默认异步通知地址 |
| `return_url` | string | 否 | 默认同步跳转地址 |

#### 更新签名配置

`PUT /api/merchant/developer/signature`

请求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `api_key_type` | string | 是 | `hmac-sha256`、`md5`、`rsa` |
| `rsa_public_key` | string | 否 | RSA 模式必填 |

#### 重置 API Key

`POST /api/merchant/developer/api-key/reset`

请求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `password` | string | 是 | 当前登录密码 |

规则：

- 需要验证当前密码。
- 成功后生成新的 `api_key`。
- 旧密钥立即失效。
- 记录 `operation_logs`。

### 域名接口

#### 域名列表

`GET /api/merchant/domains`

#### 新增域名

`POST /api/merchant/domains`

请求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `domain` | string | 是 | 域名，不包含协议和路径 |

#### 删除域名

`DELETE /api/merchant/domains/:id`

规则：只能删除当前商户自己的域名。

### 账户设置接口

#### 更新资料

`PUT /api/merchant/profile`

允许更新字段：

- `email`
- `contact_qq`
- `contact_wechat`
- `contact_phone`
- `settle_type`
- `settle_account`
- `settle_name`

#### 修改密码

`POST /api/merchant/password`

说明：当前已存在，可继续使用。需要确保更新成功后前端提示用户重新登录。

## 六、权限与安全要求

### 数据权限

- 所有用户中心查询必须使用当前登录用户的 `user.id` 作为条件。
- 不允许从请求参数接收 `user_id` 决定数据归属。
- 管理员后台和用户中心权限分离，`role = 'admin'` 不默认代表当前商户身份。

### 登录安全

- 登录失败不区分“用户不存在”和“密码错误”。
- 禁用账号不允许登录。
- 可后续接入 KV 限流：按 IP 和用户名限制登录失败次数。
- JWT Secret 必须来自 `JWT_SECRET`，不能依赖默认值上线。

### 敏感信息

- API Key 默认脱敏展示，只在复制或重置后短暂展示完整值。
- RSA 私钥不进入本系统，只保存商户 RSA 公钥。
- 操作日志不记录明文密码、完整 API Key、完整银行卡号。

### 审计日志

以下操作需要写入 `operation_logs`：

- 登录成功和登录失败。
- 修改密码。
- 修改结算资料。
- 修改回调地址。
- 修改签名方式。
- 重置 API Key。
- 新增或删除域名白名单。
- 申请结算。
- 发起退款。

## 七、前端实现建议

### 技术形态

第一阶段可沿用当前管理后台模式：在 `src/index.ts` 内联单文件 HTML、CSS、JavaScript，提供 `/user` 页面。后续如独立前端项目落地，再迁移为独立静态页面。

### 布局

- 桌面端使用左侧导航 + 顶部用户栏 + 主内容区。
- 移动端使用抽屉导航。
- 与管理后台保持相近交互习惯，但视觉上降低管理感，突出账户、交易、接口配置。

### 导航菜单

| 菜单 | 图标建议 | 页面 |
|------|----------|------|
| 仪表盘 | dashboard | `/user/dashboard` |
| 订单管理 | receipt | `/user/orders` |
| 结算管理 | wallet | `/user/settlements` |
| 退款管理 | refund | `/user/refunds` |
| 接口配置 | code | `/user/developer` |
| 域名白名单 | global | `/user/domains` |
| 账户设置 | settings | `/user/settings` |

## 八、后端实现顺序

1. 新增 `POST /api/merchant/login`，复用 `verifyPassword` 和 `signJWT`。
2. 调整用户中心认证后的用户数据获取方式：JWT 只作为身份凭证，接口内按 `id` 查询最新用户行。
3. 新增 `/user` 页面入口和登录页。
4. 完善 `GET /api/merchant/profile` 和 `GET /api/merchant/dashboard`。
5. 新增用户中心订单、退款、接口配置、域名白名单接口。
6. 补充操作日志和关键操作二次验证。
7. 手动验证登录、登录失效跳转、订单列表、结算申请、修改密码、重置 API Key。

## 九、与现有代码的关系

当前代码中已存在：

- `src/routes/merchant.ts`：`/query`、`/settle/list`、`/settle/apply`、`/password`。
- `src/middleware/auth.ts`：Bearer Token 校验、商户权限中间件。
- `src/routes/admin.ts`：管理员登录实现，可作为商户登录接口参考。
- `src/routes/pay.ts`：易支付订单查询、退款、关闭订单等兼容接口。

需要注意的实现差异：

- 当前 `/api/merchant/*` 已挂载 `authMiddleware` 和 `merchantMiddleware`，新增 `/login` 时需要放在认证中间件之前。
- 当前 `authMiddleware` 将 JWT payload 放入 `c.set('user')`，用户中心接口不能依赖 payload 中的余额、结算账号等动态字段，应按 `payload.id` 查询数据库最新数据。
- 当前易支付接口通过 `pid + key/sign` 鉴权，用户中心接口通过 JWT 鉴权，两者不要混用。

## 十、验收标准

- 未登录访问 `/user` 显示登录页或跳转 `/user/login`。
- 正常商户可以登录并看到自己的余额、订单和结算信息。
- 禁用商户无法登录。
- 用户中心所有数据只能返回当前登录商户的数据。
- Token 失效后自动退出并回到登录页。
- 修改密码后旧密码不可继续登录。
- 申请结算会冻结余额并生成结算记录。
- 重置 API Key 后旧密钥无法继续调用易支付接口。
