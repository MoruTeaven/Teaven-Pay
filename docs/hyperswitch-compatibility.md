# Hyperswitch 接口兼容性评估

> 评估日期：2026-11-27
> 结论先行：**Teaven Pay 与 Hyperswitch 不在同一层，当前不构成重复造轮子；兼容 Hyperswitch 接口技术上可分三层评估，推荐走「Stripe 风格兼容层」而非重造编排能力。**

## 1. 背景

团队关注两个问题：

1. Teaven Pay 相对 Hyperswitch（juspay/hyperswitch，Apache-2.0）是否重复造轮子；
2. 能否兼容 Hyperswitch 的接口。

两者都落在「支付」这个大词下，但定位不同：

| 维度 | Hyperswitch | Teaven Pay |
| --- | --- | --- |
| 定位 | 多 PSP 支付编排 / orchestration | 聚合支付网关 + 商户平台 |
| 抽象 | Rust 六边形架构，Router + Scheduler（Producer/Consumer） | TypeScript / Hono / Cloudflare Workers，单 Worker |
| 面向 | 已有多收单渠道的大商户、平台 | 需快速接入支付宝/微信/QQ 的站点与运营方 |
| 部署 | PostgreSQL + Redis + Kafka，K8s/Helm 自托管或 SaaS | D1(SQLite) + KV，边缘零运维 |
| 核心能力 | 智能路由、智能重试/收入恢复、3DS、反欺诈、Vault、对账、成本观测、PCI 合规 | 下单/查询/退款/关单、商户后台、结算、签名验签、SSRF 防护、幂等入账 |
| 通道规模 | 200+ connector / 150+ 支付方式 | 支付宝/微信/QQ/Dodo 等少量深度集成 |
| 对外协议 | 现代支付 API（含 Stripe 兼容层） | 通用支付协议 submit.php / api.php 兼容 |

**真正重叠的部分**（多通道抽象、订单/退款状态机、回调幂等、金额核对）是支付领域的必做领域核心，不是通用库能替代的轮子。

**能力边界提醒**：若 Teaven Pay 未来要做智能路由、失败重试恢复、对账或 Vault，就进入 Hyperswitch 的射程，到时应评估复用/集成其模块，而不是自己从零重写。

## 2. 「兼容 Hyperswitch」的两个方向

### 方向 A：成为 Hyperswitch 的一个 connector（被 Hyperswitch 调用）

- 需在 Hyperswitch 仓库实现其 `ConnectorIntegration` / `ConnectorCommon` 等 Rust trait，并写 `TryFrom` 请求响应映射；
- 成本高，且把项目命运绑在对方的重栈上；
- **现实障碍**：Hyperswitch 的 connector 枚举里 `ali_pay` / `we_chat_pay` 只是 payment method 类型，并没有现成的支付宝/微信 connector——即使做了 connector，中文渠道仍需从零实现，我们现有插件优势完全用不上。
- 结论：不划算，不建议。

### 方向 B：加一层 Hyperswitch 风格 API 兼容层（本文档重点）

让原本调用 Hyperswitch 的客户端能把 base URL 切到 Teaven Pay。按深度分三层：

| 层次 | 范围 | 可行性 |
| --- | --- | --- |
| L1 传输层 | 端点路径、认证头、JSON 形状 | 可行（低成本） |
| L2 语义层 | 状态机、金额单位、错误码、Webhook | 部分可行 |
| L3 能力层 | 多 PSP 路由、3DS、Vault、client_secret SDK 流程、connector 管理 API | 不可行（等于重造整个轮子） |

## 3. L1/L2 字段映射（最小可行子集）

| Hyperswitch | Teaven Pay | 转换要点 |
| --- | --- | --- |
| `POST /v1/payments` | `POST /api/pay/submit` | amount 分转元；currency 目前仅 CNY |
| `POST /v1/payments/{id}/confirm` | 无对应 | 无两阶段确认，需合并到 create |
| `GET /v1/payments/{id}` | `GET /api/pay/query` | payment_id 映射 trade_no |
| `GET /v1/payments` | `GET /api/pay/orders` | 分页参数映射 |
| `POST /v1/refunds` | `POST /api/pay/refund` | amount 分转元 |
| `GET /v1/refunds/{id}` | `GET /api/pay/refund/query` | — |
| `POST /v1/payments/{id}/cancel` | `POST /api/pay/close` | — |
| `amount`（minor units，分） | `money`（元，两位小数字符串） | `amount / 100` 转元 |
| `currency: CNY` | 默认 CNY | 非 CNY 需扩展 |
| `payment_method` + `payment_method_data` | `type` | 卡类字段无对应，中文渠道用 type 即可 |
| `payment_id` / `id` | `trade_no` | 平台订单号 |
| `status: succeeded / failed / processing` | `status: 0/1/2/3` | 见状态机映射 |
| `api-key` 请求头 | `X-API-Key` / `Authorization: Bearer` | 只差头名映射 |
| `error { error_code, error_message, error_type }` | `code` + `msg` | 错误对象转换 |

### 状态机映射

| Hyperswitch IntentStatus | Teaven Pay status | 说明 |
| --- | --- | --- |
| `requires_payment_method` / `requires_confirmation` | 无 | 我们无两阶段意图模型 |
| `processing` | 0（未支付） | 下单后待支付 |
| `succeeded` | 1（已支付） | — |
| `requires_capture` | 无 | 我们无手动请款 |
| `canceled` | 3（已关闭） | — |
| `failed` | 无直接对应 | 可映射到关单或退款失败 |

### 错误模型

Hyperswitch 返回 `{ error: { error_code, error_message, error_type, status_code } }` 并配 HTTP 4xx；Teaven Pay 现行是 HTTP 200 + `code/msg`。兼容层需在 HTTP 状态码与响应体两层做转换，注意不影响现有易支付客户端（走独立路径，不改原接口）。

### Webhook

- Hyperswitch 事件：`payment_succeeded` / `payment_failed` / `payment_processing` / `payment_cancelled` / `payment_authorized` / `payment_captured`，POST JSON，签名头 `x-webhook-signature-512`。
- Teaven Pay 现有出站通知是表单 POST + `sign` 参数，商户返回 `success`，重试 1/5/30 分钟 + 1/6 小时共 5 次。
- 兼容层需按事件类型重新封装 payload 并签名，作为独立的 webhook 发送渠道，不改动现有通知链路。

## 4. 最大阻碍：模型差异

不是字段，而是模型：

- Hyperswitch 是 **PaymentIntent 状态机 + client_secret + 浏览器 SDK**，走 `requires_action`（3DS）、`requires_capture`（手动请款）等流程；
- Teaven Pay 是**收银台 URL / 二维码 + 四态订单**。

SDK 流程对不上。因此 L1/L2 只能服务「服务端直连」客户，覆盖不了走官方 JS SDK 的客户。这部分属于 L3，不建议补。

## 5. 推荐路线

1. **优先兼容 Stripe，而非 Hyperswitch 专有 API**：Hyperswitch 官方自带 Stripe 兼容层（`crates/router/src/compatibility/wrap.rs`），意味着 Hyperswitch 生态客户端本来就能说 Stripe 的语言。做一份 Stripe 风格 `/v1/payment_intents` 兼容，可同时覆盖 Stripe 与 Hyperswitch 两个生态，且 Stripe 文档/SDK 最成熟、参照实现最多。
2. **只做服务端直连最小子集**：create / retrieve / refund / webhook 四个能力，不碰 client_secret / 3DS / Vault。
3. **独立路由前缀隔离**：兼容层挂在新前缀（如 `/v1/*`），不动现有 `/api/pay/*` 与易支付入口，避免破坏存量商户。
4. **金额转换集中处理**：封装 `minorUnitsToYuan` / `yuanToMinorUnits` 工具，含 currency 校验（非 CNY 直接拒绝，明确报错）。
5. **认证复用现有 API Key 体系**：Hyperswitch `api-key` 头映射到现有 `X-API-Key` / `Authorization: Bearer`，密钥仍只认 `api_keys` 表。
6. **测试先行**：为字段映射、状态机、金额转换、错误码写契约测试，确保兼容层不污染主流程。

## 6. 风险与边界

- 兼容层是**单向适配**：Teaven Pay 表达不了的 Hyperswitch 能力（路由/3DS/Vault）不能伪装支持，需明确返回不支持错误。
- 多币种是扩展点，当前仅 CNY，兼容层要显式拒绝非 CNY 而非静默按 CNY 处理。
- 兼容层不能成为安全后门：API Key 校验、SSRF 校验、签名验签、幂等入账等主流程约束必须同样生效。
- 若未来真要接 Hyperswitch 编排能力，优先评估把 Teaven Pay 的中文渠道做成 Hyperswitch 侧的独立服务（而非在 Teaven Pay 内重造编排）。

## 7. 已实现（Stripe 兼容层 · t-mwz1l37b）

已按上述路线落地 Stripe 风格兼容层（服务端直连最小子集），代码位于 `src/routes/stripe.ts`、`src/utils/stripe-compat.ts`，挂载在独立前缀 `/v1/*`，不改动 `/api/pay/*` 与易支付入口。

### 可用端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/payment_intents` | 创建支付（amount 为分，metadata.type 指定支付方式） |
| `GET /v1/payment_intents/:id` | 查询支付状态 |
| `GET /v1/payment_intents` | 订单列表（limit / starting_after 分页） |
| `POST /v1/payment_intents/:id/cancel` | 关闭未支付订单 |
| `POST /v1/refunds` | 申请退款（payment_intent + amount） |
| `GET /v1/refunds/:id` | 查询退款 |

- 认证：`Authorization: Bearer sk_<api_key>`（兼容 `sk_test_` / `sk_live_` 前缀，也接受裸密钥与 `X-API-Key`），密钥仍只认 `api_keys` 表。
- 金额：请求/响应均为最小货币单位（分），内部自动转元；仅支持 `cny`，其它币种返回 400。
- 响应：Stripe PaymentIntent / Refund 对象 + `{ error: { type, code, message, status_code } }` 错误模型与对应 HTTP 状态码。
- 不支持的能力（confirm / capture / customers）返回明确的 `unsupported_feature` 错误，不伪装支持。
- 业务逻辑内部转发给现有 `payRouter`，完整复用签名验签、SSRF 校验、幂等入账等主流程。
- 幂等：用 `metadata.out_trade_no` 或 `idempotency_key` 作为商户订单号，重复请求返回同一笔订单。
- 契约测试：`src/utils/stripe-compat.test.ts`（纯函数）+ `src/routes/stripe.test.ts`（路由），共 30 项全通过。

## 8. 参考资料

- Hyperswitch 架构：<https://docs.hyperswitch.io/about-hyperswitch/hyperswitch-architecture>
- Hyperswitch API Reference：<https://api-reference.hyperswitch.io/introduction>
- Payments API：<https://api-reference.hyperswitch.io/v1/payments/payments--create>
- Refunds API：<https://api-reference.hyperswitch.io/v1/refunds/refunds--create>
- Webhooks：<https://docs.hyperswitch.io/integration-guide/webhooks>
- 错误码：<https://api-reference.hyperswitch.io/essentials/error_codes>
- Stripe 迁移：<https://docs.hyperswitch.io/other-features/payment-orchestration/quickstart/migrate-from-stripe/web>
- 新增 connector 指南：<https://github.com/juspay/hyperswitch/blob/main/add_connector.md>
- Stripe 兼容层源码：<https://github.com/juspay/hyperswitch/blob/main/crates/router/src/compatibility/wrap.rs>
