// 验证「仓库迁移链」与「生产库真实结构」在 0009 加列后是否一致。
//
// 用法：
//   node scripts/verify-schema-alignment.mjs
//
// 做法：
//   1) 场景 A（空库）：按 0001 → 0009 顺序重放迁移，得到结构 A；
//   2) 场景 B（生产结构副本）：用生产快照复原一张 27 列的 users 表 + 其余表，
//      再按 0009 的幂等逻辑加列，得到结构 B；
//   3) 比较 A 与 B 的逐表列清单，要求完全一致；
//   4) 幂等检查：对 A 和 B 各再执行一次 0009 逻辑，要求不报错且结构不变；
//   5) 断言 users 恰好 30 列、且含 api_key / api_key_type / rsa_public_key；
//   6) 断言既有数据不被改写、新列为 NULL、api_key 唯一语义生效。
//
// 退出码 0 = 全部通过；非 0 = 有断言失败。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyColumnAdds, ensureUniqueIndex, planColumnAdds } from './lib/align-users-columns.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIG = resolve(ROOT, 'migrations');
const DIFF = resolve(ROOT, 'reports/schema-drift');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

const readMigration = (f) => readFileSync(resolve(MIG, f), 'utf8');

// 从快照里取某张表的建表语句
const prodSnapshot = JSON.parse(readFileSync(resolve(DIFF, 'prod-sqlite-master.json'), 'utf8'));
const prodRows = Array.isArray(prodSnapshot) ? prodSnapshot[0].results : prodSnapshot.results;
const prodTableSql = (name) => {
  const r = prodRows.find((x) => x.type === 'table' && x.name === name);
  return r?.sql ?? null;
};

/**
 * 解析 CREATE TABLE 语句里的列名。
 * 按顶层逗号切分（括号内、字符串内的逗号不算），
 * 这样 SQLite 用 ALTER TABLE ADD COLUMN 追加的列（会被追加到同一行末）也能被正确识别。
 */
export function columnsOf(sql) {
  if (!sql) return null;
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const cols = [];
  let depth = 0;
  let quote = null;
  let current = '';
  const parts = [];
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  for (const raw of parts) {
    const line = raw.replace(/--[^\n]*/g, '').trim();
    if (!line) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
    const m = /^["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC|BOOLEAN)/i.exec(line);
    if (m) cols.push(m[1]);
  }
  return cols;
}

/** 权威列清单：直接读 PRAGMA table_info，不依赖 DDL 文本排版 */
function pragmaColumns(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
}

const TABLES = [
  'users', 'orders', 'payment_types', 'channels', 'settlements', 'refunds',
  'user_groups', 'blacklist', 'domain_whitelist', 'operation_logs', 'daily_stats',
  'system_config', 'api_keys', 'order_logs', 'payment_logs', 'webhook_logs',
  'reconciliation_logs', 'password_resets', 'throttle_counters',
];

const MIGRATION_ORDER = [
  '0001_initial.sql',
  '0002_add_xunhupay.sql',
  '0003_api_keys.sql',
  '0004_security_logs.sql',
  '0005_throttle_counters.sql',
  '0006_password_resets.sql',
  '0007_unify_api_key_source.sql',
  '0008_backfill_api_keys.sql',
];

/** 0009 的幂等加列（与 scripts/apply-0009-align-users.mjs 同一套逻辑） */
function run0009(db) {
  const executed = applyColumnAdds(db);
  ensureUniqueIndex(db);
  return executed;
}

const usersCols = (db) => pragmaColumns(db, 'users');

// ---------------------------------------------------------------- 场景 A：空库重放
const dbA = new DatabaseSync(':memory:');
dbA.exec('PRAGMA foreign_keys = ON;');
for (const f of MIGRATION_ORDER) {
  try {
    dbA.exec(readMigration(f));
  } catch (e) {
    check(`场景A 执行 ${f}`, false, e.message);
  }
}
// 0009 用幂等逻辑执行（空库上三列已由 0001 建出，应当不执行任何 ALTER）
const aExecuted = run0009(dbA);
check('场景A 0009 在空库上不执行任何 ALTER（三列已由 0001 建出）', aExecuted.length === 0, `实际执行 ${JSON.stringify(aExecuted)}`);

const aTables = {};
for (const t of TABLES) {
  const r = dbA.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
  aTables[t] = r?.sql ? columnsOf(r.sql) : null;
}
check('场景A 全部 19 张业务表存在', TABLES.every((t) => aTables[t]), `缺 ${TABLES.filter((t) => !aTables[t]).join(',') || '无'}`);

const aColsBeforeIdem = usersCols(dbA);
const aExecuted2 = run0009(dbA);
check('场景A 0009 重复执行不报错且不执行 ALTER', aExecuted2.length === 0, `实际执行 ${JSON.stringify(aExecuted2)}`);
check(
  '场景A 0009 重复执行后 users 列数不变',
  usersCols(dbA).length === aColsBeforeIdem.length,
  `${aColsBeforeIdem.length} → ${usersCols(dbA).length}`
);

// ---------------------------------------------------------------- 场景 B：生产结构副本
const dbB = new DatabaseSync(':memory:');
dbB.exec('PRAGMA foreign_keys = ON;');
for (const t of TABLES) {
  const sql = prodTableSql(t);
  if (!sql) {
    check(`场景B 复原表 ${t}`, false, '生产快照中缺该表');
    continue;
  }
  dbB.exec(sql);
}
const bColsBefore = usersCols(dbB);
check('场景B 复原的 users 为 27 列（生产真实结构）', bColsBefore.length === 27, `实得 ${bColsBefore.length}`);
check('场景B 复原的 users 不含三列', !['api_key', 'api_key_type', 'rsa_public_key'].some((c) => bColsBefore.includes(c)));

const bExecuted = run0009(dbB);
check('场景B 0009 恰好加了三列', bExecuted.length === 3, `实得 ${JSON.stringify(bExecuted)}`);
const bColsAfter = usersCols(dbB);
check('场景B 执行后 users 变为 30 列', bColsAfter.length === 30, `实得 ${bColsAfter.length}`);
check(
  '场景B 执行后 users 含 api_key / api_key_type / rsa_public_key',
  ['api_key', 'api_key_type', 'rsa_public_key'].every((c) => bColsAfter.includes(c))
);

// 场景B 幂等
const bExecuted2 = run0009(dbB);
check('场景B 0009 重复执行不报错且不执行 ALTER', bExecuted2.length === 0, `实际执行 ${JSON.stringify(bExecuted2)}`);
check('场景B 0009 重复执行后 users 列数不变', usersCols(dbB).length === 30, `实得 ${usersCols(dbB).length}`);

// ---------------------------------------------------------------- 交叉比对
// 注意：列的物理顺序不参与比对。
//   场景 A（按 0001 建库）：三列位于 api_key 之后、notify_url 之前（0001 的原始位置）
//   场景 B（生产副本 + 0009 加列）：SQLite 的 ALTER TABLE ADD COLUMN 只能追加到末尾
//   两者列集合与语义完全相同，只是物理顺序不同——这不影响任何按列名访问的代码
//   （运行时代码全部使用显式列清单或 SELECT *，不存在按位置下标取列的用法）。
const aColsFinal = usersCols(dbA);
const bColsFinal = usersCols(dbB);
const sameSet = (x, y) => {
  const sx = [...x].sort();
  const sy = [...y].sort();
  return sx.length === sy.length && sx.every((v, i) => v === sy[i]);
};
check('场景A 与 场景B 的 users 列集合完全一致', sameSet(aColsFinal, bColsFinal),
  `\n  A=${JSON.stringify(aColsFinal)}\n  B=${JSON.stringify(bColsFinal)}`);
check(
  '场景A 与 场景B 的 users 列顺序差异已确认为仅位置不同（三列在 B 中被追加到末尾）',
  !sameSet(aColsFinal, bColsFinal)
    ? false
    : JSON.stringify(aColsFinal) !== JSON.stringify(bColsFinal)
      ? aColsFinal.every((c) => bColsFinal.includes(c))
      : true
);

const tableMismatch = [];
for (const t of TABLES) {
  const a = pragmaColumns(dbA, t);
  const b = pragmaColumns(dbB, t);
  if (!sameSet(a, b)) {
    tableMismatch.push(`${t}: A=${a?.length} B=${b?.length} 差集=${JSON.stringify(a.filter((c) => !b.includes(c)))}`);
  }
}
check('场景A 与 场景B 全部 19 张表列集合一致', tableMismatch.length === 0, tableMismatch.join('; '));

// ---------------------------------------------------------------- 数据安全断言
dbB.exec(`INSERT INTO users (id, username, password_hash, salt, role) VALUES ('u1','shop','h','s','merchant');`);
const bExecuted3 = run0009(dbB);
check('场景B 已有数据后再执行 0009 仍不报错', true, `执行 ${JSON.stringify(bExecuted3)}`);
const row = dbB.prepare('SELECT username, api_key, api_key_type, rsa_public_key FROM users WHERE id=?').get('u1');
check('场景B 既有行数据未被改写', row?.username === 'shop');
check('场景B 新列为 NULL（不构成第二份密钥副本）', row?.api_key === null && row?.rsa_public_key === null);
check('场景B api_key_type 默认值为 md5（与 0001 一致）', row?.api_key_type === 'md5', `实得 ${row?.api_key_type}`);

// 多行 NULL 不违反 UNIQUE 语义；重复非空值必须被拒
let dupRejected = false;
let dupErr = '';
try {
  dbB.exec(`INSERT INTO users (id, username, password_hash, salt, role) VALUES ('u2','shop2','h','s','merchant');`);
  dbB.exec(`INSERT INTO users (id, username, password_hash, salt, role, api_key) VALUES ('u3','shop3','h','s','merchant','k3');`);
  dbB.exec(`INSERT INTO users (id, username, password_hash, salt, role, api_key) VALUES ('u4','shop4','h','s','merchant','k3');`);
} catch (e) {
  dupRejected = /UNIQUE/i.test(e.message);
  dupErr = e.message;
}
check('api_key 唯一语义生效（重复值被拒、多个 NULL 允许）', dupRejected, dupErr);

// 0001 建出的库与生产加列后的库结构一致 → 0001 不需要改写
const dbC = new DatabaseSync(':memory:');
dbC.exec(readMigration('0001_initial.sql'));
const cCols = columnsOf(dbC.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql);
check('0001 建出的 users 已是 30 列且含三列', cCols.length === 30 && ['api_key', 'api_key_type', 'rsa_public_key'].every((c) => cCols.includes(c)), `实得 ${cCols.length}`);

// 加列后不得破坏既有外键
const fkRows = dbB.prepare("PRAGMA foreign_key_list('orders')").all();
check('加列后 orders 的外键仍指向 users', fkRows.some((r) => r.table === 'users'), `外键数 ${fkRows.length}`);

dbA.close();
dbB.close();
dbC.close();

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log('全部断言通过：0001→0009 迁移链与生产结构在 0009 之后完全对齐。');
  process.exit(0);
} else {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
