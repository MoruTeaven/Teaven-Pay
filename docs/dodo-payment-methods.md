# DodoPayments 支付方式与通道

## 概念：支付方式 ≠ 通道

这是理解 DodoPayments 接入的关键，两者属于完全不同的层面：

| | 支付方式（payment_types） | 通道（channels） |
|---|---|---|
| 归属 | **用户侧**：付款人在收银台看到并选择的选项 | **后台侧**：平台用哪套账号/密钥去收款 |
| 例子 | 信用卡、Apple Pay、微信支付、iDEAL | 一个配置了 Dodo API 密钥 + PWYW 产品的通道 |
| 谁创建 | 随迁移导入的默认数据（本文 29 种） | **只能由管理员在后台自行创建，仓库不预置任何通道** |
| 存储 | `payment_types` 表 | `channels` 表，`config` 字段 AES-GCM 加密 |
| 关系 | 一个支付方式可以有多条通道（下单取 sort_order 最小的一条启用通道） | 一条通道只属于一个支付方式 |

**一句话**：支付方式回答"用户用什么付款"，通道回答"平台收这笔钱走哪个账号"。用户选了「iDEAL」，最终由管理员自己建的某条 Dodo 通道完成收款。

> 因此本仓库只附带支付方式清单和插件代码，**不会**预设任何 Dodo 通道，也不会写入任何 API 密钥、产品 ID 或 Webhook 密钥。

## 已导入的用户侧支付方式

来源：Dodo 官方文档 [Available Method Types](https://docs.dodopayments.com/features/payment-methods.md)。`标识` 既是 `payment_types.name`，也是 Dodo API `allowed_payment_method_types` 的取值。导入迁移：[0015_expand_dodopayments_methods.sql](../migrations/0015_expand_dodopayments_methods.sql)。

| 支付方式 | 标识 | 说明 |
|---|---|---|
| 信用卡 | `credit` | Visa / Mastercard / Amex / JCB 等，全球通用 |
| 借记卡 | `debit` | 全球通用的借记卡 |
| Apple Pay | `apple_pay` | 苹果设备钱包支付 |
| Google Pay | `google_pay` | 谷歌钱包支付 |
| Amazon Pay | `amazon_pay` | 亚马逊钱包支付 |
| Cash App Pay | `cashapp` | 美国 Cash App 钱包 |
| ACH 直接借记 | `ach` | 美国银行账户借记，仅一次性支付 |
| Klarna | `klarna` | 先买后付，美国 / 欧洲 |
| Afterpay / Clearpay | `afterpay_clearpay` | 先买后付，美国 / 英国 |
| UPI | `upi_intent` | 印度统一支付接口（扫码） |
| iDEAL | `ideal` | 荷兰本地银行转账 |
| Bancontact | `bancontact_card` | 比利时银行卡支付 |
| EPS | `eps` | 奥地利在线银行转账 |
| Multibanco | `multibanco` | 葡萄牙本地支付网络 |
| BLIK | `blik` | 波兰本地移动支付 |
| SEPA 直接借记 | `sepa` | 欧元区银行直接借记 |
| Satispay | `satispay` | 欧洲移动支付 |
| PAYCO | `payco` | 韩国本地钱包 |
| Naver Pay | `naver_pay` | 韩国 Naver 钱包 |
| Kakao Pay | `kakao_pay` | 韩国 Kakao 钱包 |
| RevolutPay | `revolut_pay` | Revolut 钱包，GBP 结算 |
| Billie | `billie` | 企业先买后付（B2B） |
| Pix | `pix` | 巴西即时银行转账 |
| 稳定币 | `crypto_currency` | 稳定币支付，USD 结算 |
| WeChat Pay | `we_chat_pay` | 微信扫码支付，USD / CNY，单笔上限 1000 CNY |
| GCash | `gcash` | 菲律宾电子钱包 |
| Alipay HK | `ali_pay_hk` | 香港支付宝，HKD 结算 |
| FPS | `fps` | 香港快速支付系统 |
| Touch 'n Go | `touch_n_go` | 马来西亚电子钱包 |

> 注：Dodo 官网宣传"40+ 种支付方式"，OpenAPI 枚举列出 100+ 个代码（含各国 ATM / 便利店等细分渠道）。这里导入的是官方明确列出的 **29 种标准支付方式**。PayPal 官方标注为"暂停新交易"，故不在清单内。

支付方式清单在代码中集中定义于 [src/plugins/dodopayments-methods.ts](../src/plugins/dodopayments-methods.ts)，插件的 `supportedTypes` 与迁移数据都以此为唯一口径。

## 管理员如何创建 Dodo 通道

支付方式导入后，收银台还不会显示它们——因为**没有通道**。管理员需要为要开通的每一种支付方式各建一条通道：

1. 后台「支付方式」页确认目标支付方式已启用。
2. 后台「通道」页新增通道，插件选 `DodoPayments`，支付方式选对应项。
3. 在通道配置表单填写：
   - **API 密钥**：`dodo_test_...`（测试）或 `dodo_live_...`（生产）；环境按前缀自动选择。
   - **产品 ID**：Dodo 后台开启了 **Pay What You Want** 的一次性产品 ID。普通固定价产品会忽略下单金额，导致买家少付。
   - **Webhook 验签密钥**：`whsec_...`，来自 Dodo 控制台的 Webhook 端点。
   - **支付方式代码**：本通道对应的 method code（与支付方式标识一致，如 `we_chat_pay`）。留空则由 Dodo 自动展示所有可用方式。
   - **信用卡兜底**：默认关闭（严格只展示所选方式）；若目标用户可能没有该方式，可开启附带信用卡/借记卡。
   - **币种**：默认 USD；PWYW 产品仅支持 USD / GBP / EUR。
4. 在 Dodo 控制台添加 Webhook 端点 `https://<你的域名>/notify/dodopayments`，订阅 `payment.succeeded` 与 `payment.failed`。

多个通道可以共用同一套 API 密钥与 Webhook 密钥（各自加密存储）；只有 `支付方式代码` 不同。

## 实现说明

- 下单走 `POST /checkouts`，插件把通道配置的 `payment_method_type` 转成 `allowed_payment_method_types` 下发给 Dodo，从而让 hosted checkout 只展示用户选的方式。白名单会被校验，非法代码不会发给渠道。
- 回调走 Standard Webhooks 验签，履约只认 `payment.succeeded`。
- 查单 `GET /payments/{id}`、退款 `POST /refunds`。
- 目前只支持全额退款（Dodo 部分退款需要稳定的 `item_id`，PWYW 产品不提供）。
- 收银台图标取自 `payment_types.icon`（Remix Icon 类名）。
