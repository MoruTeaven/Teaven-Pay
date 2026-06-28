# Agents Guide

本文件用于让 AI 代理或协作者快速理解本仓库。修改代码前优先阅读本文件、`README.md`、相关 `docs/` 文档和目标源码。

## 项目概览

Teaven Pay 是基于 Cloudflare Workers 的易支付聚合支付系统。

- 运行时：Cloudflare Workers
- Web 框架：Hono
- 语言：TypeScript，开启 `strict`
- 数据库：Cloudflare D1，SQLite 语法
- 缓存/限流：Cloudflare KV，当前 `wrangler.toml` 中 KV 配置处于注释状态
- 支付插件：支付宝、微信支付、QQ 钱包插件位于 `src/plugins/`

## 当前目录结构

- `src/index.ts`：Workers 入口，挂载全局中间件、API 路由、兼容易支付入口和内联管理后台页面
- `src/routes/pay.ts`：支付下单、查询、退款、关闭订单等支付 API
- `src/routes/merchant.ts`：商户相关 API
- `src/routes/admin.ts`：管理后台 API 和管理员登录逻辑
- `src/routes/notify.ts`：支付渠道异步通知入口和支付成功后的订单/余额更新
- `src/plugins/`：支付插件实现与注册表，新增插件需实现 `PaymentPlugin`
- `src/middleware/`：认证、限流、错误处理等中间件
- `src/types/`：Cloudflare 绑定、数据库行、支付插件类型定义
- `src/utils/`：签名、密码哈希、AES、UUID 等工具函数
- `migrations/`：D1 初始化和修复 SQL
- `docs/`：API、部署、插件开发和后台设计文档
- `admin/index.html`：独立管理后台静态页面/原型，当前主要后台页面也内联在 `src/index.ts`
- `dist/`、`.wrangler/`、`node_modules/`：生成或依赖目录，默认不要手动修改

## 常用命令

- 安装依赖：`npm install`
- 本地开发：`npm run dev`
- 类型检查：`npm run typecheck`
- TypeScript 构建检查：`npm run build`
- 运行测试：`npm run test`
- 代码检查：`npm run lint`
- 初始化 D1：`npm run db:init`
- 重置 D1：`npm run db:reset`
- 部署 Workers：`npm run deploy`
- 查看 Workers 日志：`npm run tail`

注意：当前仓库未发现测试文件和 ESLint 配置。默认优先运行 `npm run typecheck`；`test`、`lint` 按任务需要执行，失败时先判断是否因为仓库配置缺失。

## 开发约束

- 保持改动小而聚焦，优先修改真实源码，不要只改文档或生成文件。
- 不要把密钥、私钥、`.dev.vars`、`.env*`、真实支付渠道配置写入仓库。
- Workers 环境优先使用 Web 标准 API 和 Web Crypto，避免依赖 Node 专属运行时能力。
- D1 访问使用 `env.DB.prepare(...).bind(...).first()/run()`，避免拼接未转义 SQL。
- 涉及数据库结构变更时，在 `migrations/` 新增迁移，并同步 `src/types/env.ts` 的行类型。
- 涉及支付、签名、认证、回调、余额、退款逻辑时，必须考虑幂等性、签名校验、状态流转和错误码兼容。
- README 和部分 docs 中仍有早期 `workers/`、`frontend/` 目录描述；以当前根目录实际代码结构为准。

## 路由与兼容入口

- 健康检查：`GET /api/health`
- 支付 API：`/api/pay/*`
- 商户 API：`/api/merchant/*`
- 管理 API：`/api/admin/*`
- 异步通知：`/notify/alipay`、`/notify/wxpay`、`/notify/qqpay`、`/notify/:plugin`
- 易支付兼容：`POST /submit.php`、`/api.php?act=submit|query|order|orders|settle|refund|refundquery|close`
- 页面入口：`/cashier/:tradeNo`、`/result/:tradeNo`、`/admin`

## 数据库要点

主迁移文件是 `migrations/0001_initial.sql`。

- `users`：管理员和商户，包含 API 密钥、余额、结算信息
- `orders`：订单主表，`status` 为 `0` 未支付、`1` 已支付、`2` 已退款、`3` 已关闭
- `payment_types`：支付方式，如 `alipay`、`wxpay`、`qqpay`
- `channels`：支付通道，`plugin` 字段对应 `src/plugins/index.ts` 注册的插件 ID
- `settlements`：结算记录
- `refunds`：退款记录
- `operation_logs`、`daily_stats`、`system_config`：日志、统计和系统配置

## 支付插件规则

新增支付插件时：

1. 在 `src/plugins/` 新增插件文件。
2. 实现 `src/types/plugin.ts` 中的 `PaymentPlugin` 接口。
3. 在 `src/plugins/index.ts` 注册插件 ID。
4. 在迁移或种子数据中添加 `payment_types` 和 `channels` 配置。
5. 确保回调验证失败时不会更新订单，成功回调重复到达时不会重复入账。

## 签名与安全注意事项

- 商户 API 当前通过 `src/utils/crypto.ts` 的 `verifySignAsync` 校验签名。
- 默认签名类型偏向 `hmac-sha256`，同时保留 MD5 兼容模式。
- `md5`/`simpleHash` 实现有兼容风险，生产级易支付 MD5 兼容需求需要谨慎处理。
- 管理后台使用 JWT，`JWT_SECRET` 必须通过 Wrangler secret 或本地 `.dev.vars` 提供。
- 密码哈希使用 PBKDF2，迭代次数为 `77777`。

## 校验建议

完成代码修改后至少运行：

```bash
npm run typecheck
```

涉及 API、数据库或支付流程时，尽量补充或手动验证：

```bash
npm run dev
curl http://localhost:8787/api/health
```

部署前确认 `wrangler.toml`、D1 绑定、Secrets 和迁移状态正确。
