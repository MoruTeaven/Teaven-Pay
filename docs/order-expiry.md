# 未支付订单超时自动关闭

`status = 0` 的订单不会自动过期。历史验证单会长期留在订单列表，并让
`/api/pay/orders` 的 `count` 变脏。本功能通过 Cloudflare Cron Trigger
定时关闭超时未支付订单。

## 配置

TTL 读取 `system_config.order_expire_minutes`（管理后台「系统设置 → 订单过期时间 (分钟)」）：

| 值 | 行为 |
|---|---|
| 未配置 / 非数字 | 默认 **420 分钟（7 小时）** |
| `0` 或负数 | 关闭自动关单 |
| 大于 43200 | 按 43200（30 天）封顶 |

生产建议值：`420`。

```sql
UPDATE system_config SET value = '420' WHERE key = 'order_expire_minutes';
```

Cron 表达式在 `wrangler.toml`：

```toml
[triggers]
crons = ["*/7 * * * *"]   # 每 7 分钟扫描一次
```

## 行为（每一轮）

1. 读取 TTL，`<= 0` 直接返回。
2. 取 `status = 0 AND created_at < now - TTL` 的订单，按创建时间升序，单轮最多 177 笔。
3. 逐笔向渠道核对（有 `plugin` + `channel_id` 时）：
   - 渠道返回 `paid` → 走 `creditOrder()` 入账（与回调/轮询共用同一入账单元），**绝不关单**；
   - 渠道返回 `closed` / `refunded` / `pending` → 视为可关闭；
   - 查询异常、渠道记录缺失、入账被拒（金额不符/DB 错误）→ 本轮跳过，下一轮重试，**绝不盲关**。
4. 可关闭的订单执行 CAS：`UPDATE orders SET status = 3, closed_at = ? WHERE id = ? AND status = 0`，
   只有 `meta.changes > 0` 才写 `order_logs`（`action = 'closed'`，`from_status = 0`，
   `to_status = 3`，`detail.source = 'auto_expire'`）。

## 为什么必须先查渠道

`src/routes/notify.ts` 的 `handlePaymentSuccess` 在 `order.status !== 0` 时直接返回
`DUPLICATE` 并跳过入账。如果只按时间批量把订单改成 `status = 3`，渠道随后回调
「已支付」就会**钱收了但不入账**。因此「查到已支付就入账、确认未支付才关单」是硬约束。

## 运维与排查

- 每轮结果打在 Workers 日志：`[Scheduled/order-expiry] <cron> {"ttlMinutes":420,"scanned":..,"closed":..,"credited":..,"skipped":..,"failed":..}`。
- 关单流水：`SELECT * FROM order_logs WHERE action = 'closed' AND json_extract(detail, '$.source') = 'auto_expire' ORDER BY created_at DESC;`
- 渠道核对流水：`SELECT * FROM payment_logs WHERE action = 'query_order' ORDER BY created_at DESC LIMIT 50;`
- 若 `skipped` 持续偏高，通常是渠道查询失败或渠道记录被删，需人工核对后再处理。

## 已知边界

- 渠道有效期长于 7 小时、且买家在关单后才完成支付的场景，回调会因 `status = 3`
  被判定为重复通知而不入账。主流渠道二维码 2 小时内有效，7 小时已覆盖；如需彻底
  消除该风险，应另开任务在 `handlePaymentSuccess` 中对「closed 订单 + 渠道确认已支付」
  做补入账。
- 无 `plugin` / `channel_id` 的历史脏数据无法向渠道核对，会直接关单。
