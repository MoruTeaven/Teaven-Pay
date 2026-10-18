# 生产 users 表结构漂移：根因与对齐方案

> 任务：t-mv39kad0-1o8elj
> 生产库：Cloudflare D1 `teaven-pay` / `7de39fde-b84c-46bd-bb0c-01004b6f5200`
> 核查日期：2026-10-18
> 核查方式：只读（`wrangler d1 execute --remote` 全部为 SELECT / PRAGMA，`meta.changed_db=false`、`rows_written=0`）

## 一、结论

**生产 `users` 表缺少 `api_key` / `api_key_type` / `rsa_public_key` 三列，根因是 `migrations/0003_api_keys.sql` 早期版本中的一段整表重建——该重建的 `users_new` 定义不含这三列，在生产执行后随旧表一起被 `DROP`。**

不是「手工删列」，也不是「0001 后来被改写」。三条候选原因里，后两条被证据排除，第一条被机制实验复现验证。

处置方向：**加回三列**（新增幂等迁移 `0009_align_api_key_columns.sql`），不改写已发布的 0001/0003/0007。

## 二、根因证据链

### 2.1 生产事实

| 项 | 实测值 |
|---|---|
| 业务表数量 | 19（另有 `_cf_KV` 为 D1 内部表） |
| 索引数量 | 64 |
| 触发器 | 0 |
| `users` 列数 | **27**（仓库定义为 30） |
| `users` 建表语句 | `CREATE TABLE "users" (` — 表名带双引号、列定义**剥离全部行尾注释** |
| `d1_migrations` 表 | **不存在**（`no such table: d1_migrations: SQLITE_ERROR [code: 7500]`） |
| `PRAGMA foreign_keys` | 1 |
| 行数 | users 2、api_keys 1（启用）、orders 31、channels 1、payment_types 5 |

`d1_migrations` 不存在 + 仓库 `wrangler.toml` 从未配置 `migrations_dir`，说明**生产从未使用 `wrangler d1 migrations apply`**，迁移是人工逐个 `--file` 执行的。因此「迁移记录」这一证据源在本案中不存在，只能靠 DDL 特征与 git 历史。

### 2.2 DDL 指纹指向 `ALTER TABLE ... RENAME TO`

SQLite 在执行 `ALTER TABLE users_new RENAME TO users` 时会**重写 `sqlite_master` 中保存的建表语句**：表名被加双引号、注释被剥离。

生产 `users` 的 DDL 正是这个特征。提交 `2478c94`（2026-06-28 16:29）首次加入的 `0003_api_keys.sql` 中，第 43–71 行的 `CREATE TABLE users_new`：

```
CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    ...
    frozen_balance REAL DEFAULT 0,
    notify_url TEXT,          -- ← 从这里开始就没有 api_key 三列
    ...
    updated_at TEXT DEFAULT (datetime('now'))
);
DROP TABLE users;                          -- 第 88 行
ALTER TABLE users_new RENAME TO users;     -- 第 91 行
```

该 `users_new` 的列清单与生产 `users` 的 DDL **逐列完全一致、同样缺三列**。

### 2.3 机制实验：复现验证

`scripts/rename-fingerprint-check.mjs` 在本地 SQLite 上按 0001 建出带三列的 `users`，再执行上述重建序列，结果：

| 比对项 | 结果 |
|---|---|
| 重建后 DDL 与生产 DDL 归一化后是否相同 | **是**（两侧归一化长度均为 714，字符级相同） |
| 表名是否带双引号 | 是 |
| 是否保留行尾注释 | 否 |

这把根因从「基于指纹的推断」升级为**可复现的机制验证**。

### 2.4 排除另外两条候选原因

- **不是「0001 后来被改写」**：`0001_initial.sql` 于提交 `65986d3`（2026-06-23）创建时，三列就在第 15–17 行；此后该文件只被改动过 `api_key_type` 的默认值与注释（`fb2bcbc` 改成 `hmac-sha256`、`09c64fb` 改回 `md5`），从未增删过这三列。而生产 DDL 与当前 0001 也不一致，说明差异另有来源。
- **不是「系统外手工删列」**：删列的 DDL 指纹（双引号表名 + 注释剥离）由 RENAME 产生，手工 `DROP COLUMN` 不会留下这种痕迹；且该重建语句就存在于仓库的 git 历史里，不需要假设「系统外操作」。

### 2.5 这段重建为何被删掉、却已生效

`2478c94` 之后 17 分钟的提交 `a3752af`（2026-06-28 16:46）删掉了整段重建（−76 行，理由是「移除冗余代码和旧的数据库迁移脚本」）；`09c64fb`（2026-09-29）又把数据迁移段以幂等形式加回。

**生产库在两次提交之间的窗口期执行过这个版本**，于是列已被删除，而仓库侧的脚本已经不存在了——迁移历史被改写，副作用留在了生产。

## 三、逐表差异清单

机器可读清单：`reports/schema-drift/schema-diff.json`（`scripts/compare-schema-snapshots.mjs` 产出）。

| 比对结果 | 数量 |
|---|---|
| 生产业务表 | 19 |
| 仓库迁移链重放得到的业务表 | 19 |
| 表集合一致 | ✅ 完全一致 |
| 列集合与索引完全一致的表 | **18 / 19** |
| 存在结构漂移的表 | **1（仅 `users`）** |

`users` 的全部差异（3 条）：

| 类型 | 列 |
|---|---|
| `column_missing_in_prod` | `users.api_key` |
| `column_missing_in_prod` | `users.api_key_type` |
| `column_missing_in_prod` | `users.rsa_public_key` |

**其余表（orders / api_keys / channels / payment_types / settlements / refunds / user_groups / blacklist / domain_whitelist / operation_logs / daily_stats / system_config / order_logs / payment_logs / webhook_logs / reconciliation_logs / password_resets / throttle_counters）结构完全一致，无漂移。**

### 附带发现：种子数据也存在漂移

`payment_types` 的结构一致，但**数据**不一致：

| id | 生产 display_name | 仓库 0001 display_name |
|---|---|---|
| `pt_alipay` | 支付宝 | 支付宝 |
| `pt_wxpay` | 微信支付 | 微信支付 |
| `pt_qqpay` | QQ钱包 | QQ钱包 |
| `pt_unionpay` | **云闪付** | **银联** |
| `pt_jdpay` | 京东支付 | 京东支付 |
| `pt_xunhupay` | **不存在** | 虎皮椒（0002 种子） |

说明生产库在 0002 种子写入前就已建好、或该种子从未执行。**这属于数据漂移，不在本次结构对齐的处置范围内**，但它进一步印证「生产不是按仓库迁移链顺序建起」。

## 四、影响评估

| 影响项 | 状态 |
|---|---|
| 运行时是否依赖 `users.api_key*` | **否**。`src/` 下已无任何读写这三列的代码；`src/types/env.ts` 的 `UserRow` 已不含三列。密钥唯一来源是 `api_keys` 表（`src/utils/apiKeyAuth.ts` 的 `getPrimaryApiKey`） |
| `0003` 能否在生产重放 | **否**。其数据迁移段 `SELECT users.api_key` 会报 `no such column: api_key` |
| `0007` 在生产的行为 | **静默 no-op**。`WHERE api_key IS NOT NULL` 在三列缺失时恒不成立，不报错但什么都没清——**不能把它当作「已清理旧字段」的凭据** |
| `0001` 在生产的行为 | 对已存在的表完全无效（`CREATE TABLE IF NOT EXISTS` 直接跳过），补不回结构漂移 |
| 灾难恢复 / 新建环境的风险 | **真实存在**。按仓库迁移重建会得到 30 列的 `users`，与生产的 27 列不一致 |
| 现有业务数据 | 不受影响。生产 `users` 2 行、`api_keys` 1 行（启用，`hmac-sha256`）；`api_keys` 已是完整密钥来源，不存在「只在 `users.api_key` 里有」的密钥副本 |

## 五、处置方案

### 5.1 选定方向：加回三列

对比两个方向：

| | 加回三列（选定） | 改仓库定义迁就生产 |
|---|---|---|
| 对已存在的生产库 | 可执行，纯加列 | 无效——改 0001 不会影响已存在的表 |
| 新建环境的结构 | 与生产一致 | 继续与生产分叉 |
| 数据风险 | 无（新列全 NULL，既有行不动） | 无 |
| 与运行时的关系 | 兼容——运行时已不读这三列 | 兼容 |
| 改动面 | 1 个新迁移文件 | 要改写已发布过的 0001/0003/0007 |

加回的三列全部为 `NULL`，**不构成第二份密钥副本**；`api_key` 的唯一语义用唯一索引 `idx_users_api_key` 补齐（SQLite 不允许 `ALTER TABLE ADD COLUMN` 带 UNIQUE 约束，但唯一索引在唯一性判定上等价，且多个 NULL 不违反唯一约束）。

### 5.2 产物

| 文件 | 作用 |
|---|---|
| `migrations/0009_align_api_key_columns.sql` | 迁移说明 + 等价的无条件加列语句（供全新环境与人工审查） |
| `scripts/lib/align-users-columns.mjs` | 幂等加列的纯逻辑（PRAGMA 检测 → 按需 ALTER） |
| `scripts/apply-0009-align-users.mjs` | 生产执行器：默认干跑，`--apply` 才真正执行 |
| `scripts/verify-schema-alignment.mjs` | 自动验证：空库场景与生产结构副本场景双向断言 |
| `scripts/compare-schema-snapshots.mjs` | 逐表差异清单产出 |
| `scripts/rename-fingerprint-check.mjs` | 根因机制实验（RENAME 指纹复现） |
| `reports/schema-drift/` | 生产只读快照、仓库重放快照、差异清单、实验结果 |

### 5.3 幂等性怎么保证

SQLite 的 `ALTER TABLE ADD COLUMN` **不支持** `IF NOT EXISTS`，重复执行会报 `duplicate column name: api_key`（这是实测中真实踩到的失败）。因此幂等由「先读 `PRAGMA table_info` 判断缺哪几列，再按需 `ALTER`」实现：

- 空库重放：0001 已建出三列 → **不执行任何 ALTER**；
- 生产结构副本：缺三列 → 恰好执行 3 条 ALTER；
- 重复执行：第二次检测到列已存在 → **不执行任何 ALTER，不报错**。

`scripts/apply-0009-align-users.mjs`（生产执行器）与 `scripts/verify-schema-alignment.mjs`（验证）**共用同一套逻辑**（`scripts/lib/align-users-columns.mjs`），不会出现「验证通过但实际执行行为不同」。

### 5.4 验证结果

`node scripts/verify-schema-alignment.mjs` → 退出码 0，24 条断言全部通过：

- 场景 A（空库按 0001→0008 重放）：19 张表齐备，0009 不执行 ALTER，重复执行不报错、列数不变；
- 场景 B（生产 27 列结构副本）：复原为 27 列且不含三列 → 0009 恰好加 3 列 → 30 列且含三列 → 重复执行不报错、列数不变；
- A 与 B 的 19 张表**列集合**完全一致；
- 既有行数据未被改写，新列为 NULL，`api_key_type` 默认 `md5`（与 0001 一致）；
- `api_key` 唯一语义生效（重复非空值被拒、多个 NULL 允许）；
- 加列后 `orders` 的外键仍指向 `users`。

**一处必须说明的差异**：三列的**物理位置**不同——0001 建出的库中它们位于 `frozen_balance` 之后、`notify_url` 之前；生产副本上 `ALTER TABLE ADD COLUMN` 只能追加到表末尾。SQLite 的 `ALTER TABLE ADD COLUMN` 无法指定列位置，且按列名访问的代码不受影响；运行时代码全部使用显式列清单或 `SELECT *`（`SELECT *` 按列名取值），不存在按位置下标取列的用法。

## 六、执行步骤（生产操作，需人工确认）

1. 先在生产执行**干跑**确认要加的列：
   ```bash
   node scripts/apply-0009-align-users.mjs
   ```
2. 确认无误后执行：
   ```bash
   node scripts/apply-0009-align-users.mjs --apply
   ```
3. 验证：
   ```bash
   wrangler d1 execute teaven-pay --remote --command \
     "SELECT name FROM pragma_table_info('users') WHERE name IN ('api_key','api_key_type','rsa_public_key')"
   ```
   期望返回 3 行。

> 本次任务**未对生产执行任何写操作**，生产只做了只读核查。执行上述步骤前建议先导出备份：
> `wrangler d1 export teaven-pay --remote --output backup.sql`

## 七、遗留事项

| 事项 | 说明 |
|---|---|
| `payment_types` 种子数据漂移 | 生产缺 `pt_xunhupay`、`pt_unionpay` 显示名与 0001 不同。属数据漂移，未在本次处置范围内 |
| `d1_migrations` 缺失 | 生产无迁移记录体系，无法审计「哪条迁移何时执行」。建议引入 `wrangler d1 migrations` 或自建迁移登记表 |
| 两个 `0005` 编号冲突 | `0005_encrypt_channel_config.sql`（纯注释、需人工调接口）与 `0005_throttle_counters.sql` 并存。若将来启用 `migrations_dir` 自动迁移，序号会歧义 |
| `0001` 的 `api_key_type` 默认值曾两次翻转 | 现为 `md5`，而运行时实际用 `hmac-sha256`（`api_keys` 表内）。该列已废弃、不被读取，但语义上仍是误导 |
| README 漂移 | `README.md` 的表结构示例仍写 `api_rsa_public`（列名不存在）且签名示例为 MD5，与实现不符 |
| `users` 三列的历史数据 | 三列在生产从未存在过（除重建前的短暂窗口），因此**没有**需要回填的旧密钥副本；`api_keys` 表已是完整来源 |
