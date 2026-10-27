# 商户无 API 密钥的处置手册

> 对应故障：任务 `t-mv39kakr-ojbnlu` —— 生产 `api_keys` 表 0 行，唯一商户无法下单、无法通过验签。
>
> 一句话结论：**这类故障沉默发生**（库里没数据、页面上只有一句文案、无任何告警），只有商户真的去下单时才暴露。本文把「怎么发现」和「怎么修」固化下来。

---

## 1. 症状

| 现象 | 说明 |
|------|------|
| `GET /pay/:merchantId` 返回「商户未配置 API 密钥，暂无法下单」 | `src/index.ts` 取不到 `getPrimaryApiKey` 结果时走该分支 |
| `POST /api/pay/cashier` 返回 `code=-3 商户未配置 API 密钥` | `src/routes/pay.ts` 同一来源 |
| `GET /api/pay/query`、`/orders`、`/refund` 返回 `code=-3` | `authorizeSignedRequest` 查不到任何启用密钥 |
| 商户后台「接口配置」页密钥为空 | `GET /api/merchant/profile` 的主密钥取自同一张表 |

根因一句话： **`api_keys` 表里该商户没有 `status = 1` 的记录**。所有支付链路的密钥来源都被有意收敛到这一张表（`src/utils/apiKeyAuth.ts`），一处为空处处不可用。

---

## 2. 先确认，再动手

不要凭直觉补数据。按顺序跑这三条：

```bash
# ① 哪些商户没有启用密钥（这一步就能定位）
wrangler d1 execute teaven-pay --remote --command \
  "SELECT u.id, u.username, u.status,
          (SELECT count(*) FROM api_keys k WHERE k.user_id = u.id AND k.status = 1) AS active_keys
   FROM users u WHERE u.role = 'merchant' ORDER BY active_keys, u.created_at"

# ② 密钥是否真的存在过（区分「从未生成」还是「被停用/误删」）
wrangler d1 execute teaven-pay --remote --command \
  "SELECT user_id, count(*) AS total, sum(status) AS enabled FROM api_keys GROUP BY user_id"

# ③ users 三个旧列是否存在（决定能否用旧字段救回）
wrangler d1 execute teaven-pay --remote --command \
  "SELECT name FROM pragma_table_info('users')
   WHERE name IN ('api_key','api_key_type','rsa_public_key')"
```

判读：

| 结果 | 含义 | 处置 |
|------|------|------|
| `total=0` | 从未生成 | 走 §3 补种 |
| `total>0, enabled=0` | 被停用或被误删 | 若为误删走 §3；若是被有意停用，先弄清楚是谁停的，别直接开 |
| ③ 返回 3 行且 `api_key` 非空 | 旧字段还有救 | 走 §4 迁移回填，别新建（保持原密钥，下游不用改配置） |
| ③ 返回 0 行 | **结构漂移**：`users` 缺三列，`0003` 存量迁移不可重放 | 走 §3 补种，并参见 `docs/schema-drift-report.md` |

> 历史事实：生产 `users` 只有 27 列，缺这三个旧列。根因是 `0003_api_keys.sql` 早期版本里的整表重建（`DROP TABLE users` + `RENAME`），把三列连同旧表一起删了。所以本环境下 ③ 必然返回 0 行，§4 用不上——留着它是为了将来对齐了结构之后仍能参考。

---

## 3. 补种默认密钥

三种方式，**任选其一**，不要叠加执行（补两把会让主密钥口径变复杂）。

### 方式 A：推荐 —— 用迁移补种（幂等、可重复执行、不影响已有密钥）

```bash
wrangler d1 execute teaven-pay --remote --file=./migrations/0008_backfill_api_keys.sql
```

- 只处理 `role='merchant' AND status=1` 且**当前没有** `status=1` 密钥的商户；
- 密钥由 SQLite 的 `randomblob(16)` 就地生成，不经任何外部通道；
- 重复执行不会新增行，也不会覆盖商户自行重置过的密钥；
- 不依赖 `users.api_key` 旧列，所以在本环境（缺三列）也能跑。

### 方式 B：让商户自己触发自愈

`src/routes/merchant.ts` 的 `ensureMerchantHasApiKey` 在商户登录时检查并补种。让商户登录一次用户中心即可。

适合不知道密钥是否丢失、只想轻推一下的情况；缺点是密钥的生成时机不可控。

### 方式 C：面板操作（商户自助）

用户中心 →「接口配置」→ 创建/重置密钥。这是最自然的路径，前提是商户能登录且界面可用。

---

## 4. 从旧字段迁回（仅当 §2 的 ③ 确实有数据）

```bash
wrangler d1 execute teaven-pay --remote --file=./migrations/0003_api_keys.sql
```

注意这条迁移只搬 `api_key IS NOT NULL` 的行；当前生产缺三列，执行会直接报 `no such column: api_key`，**属预期行为**，不是脚本坏了。

---

## 5. 验证（必须做，不能只补不验）

```bash
# 查库 + 端到端冒烟（只读，默认不下单）
node scripts/check-merchant-api-keys.mjs --smoke

# 连收银台下单一起验（会真实下单并自动关单）
node scripts/check-merchant-api-keys.mjs --smoke --real-order
```

脚本做的事：

- 列出每个启用商户及其启用密钥数量，缺密钥直接 FAIL；
- 拉 `GET /pay/:merchantId`，确认页面正常且票据 HMAC 确实用库里那把主密钥签出；
- 用主密钥签名调 `/api/pay/query`、`/api/pay/orders`；
- **负向对照**：错密钥 → `-2`、过期时间戳 → `-2`、URL 明文 key → `-1`（新版不读 query），三项必须通过，否则说明验签形同虚设；
- `--real-order` 额外真下一单 0.01 元，核对 `orders` 落库，篡改金额对照必须为 `-2`，最后自动关单（不会留下未支付挂单）。

**只读保证**：不带 `--real-order` 时，D1 侧全是 `SELECT`（脚本会断言 `changed_db=false`、`rows_written=0`），HTTP 侧只发 `GET`；密钥一律掩码输出。

---

## 6. 收尾：历史遗留的未支付测试单（需人工确认，勿自动批量执行）

历次验证链路时留下过未支付订单（`orders.status = 0`）。它们不入账、不影响余额，但会让订单列表、`/api/pay/orders` 的 `count` 变脏。

**这类数据改动属于生产业务变更，必须先由人工确认清单再执行**，不要顺手批量清理——`status = 0` 里也可能混着真实买家尚未支付的订单（`"amount": 1` 且集中在一分钟内的多半是压测，但不能靠金额猜）。

```bash
# ① 先看：按金额与创建时间聚簇人工判读
wrangler d1 execute teaven-pay --remote --command \
  "SELECT status, amount, count(*) AS n, min(created_at), max(created_at)
   FROM orders GROUP BY status, amount ORDER BY status, amount"

# ② 导出备份（改业务数据前必做）
wrangler d1 export teaven-pay --remote --output=backup-$(date +%Y%m%d).sql

# ③ 逐个确认后，用接口关闭（推荐走接口，会写 order_logs，可追溯）
#    POST /api/pay/close  pid + trade_no + sign，成功返回 code=0（注意不是 1）
```

本次核查（2026-10-26）实测生产有 **21 笔 `status=0` 未支付订单**，其中 20 笔创建于
2026-06-28 与 2026-10-11～10-13（`CASHIER*` 前缀、金额多为 0.01/1 元），属历史验证残留；
另有 1 笔本次自检下单产生的 `01a1791f-…`，**已由脚本自动关闭（status=3）**。

> 本任务**未**对这些历史订单做任何写操作，留待确认后处置。建议另开任务，或直接忽略——它们不影响账目。

---

## 7. 防复发

这次故障之所以拖到「部署后核查」才发现，是因为没有任何东西在盯着它。已经补上的东西：

| 手段 | 位置 | 作用 |
|------|------|------|
| 自检脚本 | `scripts/check-merchant-api-keys.mjs` | 随时可跑；发现无密钥/验签失效即以非 0 退出 |
| 登录自愈 | `src/routes/merchant.ts` 的 `ensureMerchantHasApiKey` | 老商户登录自动补种，兜住存量 |
| 创建即建密钥 | 商户创建流程 | 新商户不再可能无密钥 |

还没做的（建议另开任务）：

1. **把自检挂到定期任务上**。现在是手动脚本，等于没有——要么加 cron / GitHub Actions 定时跑并告警，要么并入现有的健康检查端点。
2. **`users` 三列对齐（0009）未在生产执行**。这意味着 `0003` 的存量迁移路径在生产永远不可用，且「按仓库迁移重建库」会得到与生产不同的结构。执行步骤见 `docs/schema-drift-report.md` 第六节。
3. **`ensureMerchantHasApiKey` 只挂在登录链路上**。商户半年不登录，密钥出问题也不会自愈；而「后台管理端改商户状态/重置密钥」这类操作路径上没有对应的守卫。
4. 同名 `0005` 编号冲突（`0005_encrypt_channel_config.sql` 与 `0005_throttle_counters.sql`），将来启用自动迁移会歧义。
