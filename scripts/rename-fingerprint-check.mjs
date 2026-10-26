// 机制实验：在本地 SQLite 上复现「CREATE TABLE users_new → DROP TABLE users → ALTER TABLE ... RENAME TO users」
// 之后 sqlite_master 中保存的建表语句，验证生产 users 的 DDL 书写格式（双引号表名、列定义剥离行尾注释）
// 确实由 RENAME 重写产生，而不是手工 DROP COLUMN。
// 用法：node scripts/rename-fingerprint-check.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = resolve(ROOT, 'reports/schema-drift/rename-fingerprint');
mkdirSync(DIR, { recursive: true });

const prodDdl = readFileSync(resolve(DIR, 'prod-users-ddl.sql'), 'utf8').trim();
const rebuildSql = readFileSync(resolve(DIR, 'rebuild.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
// 先按 0001 建出带三列的 users
db.exec(`CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT UNIQUE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'merchant',
  status INTEGER DEFAULT 1, balance REAL DEFAULT 0, frozen_balance REAL DEFAULT 0,
  api_key TEXT UNIQUE, api_key_type TEXT DEFAULT 'md5', rsa_public_key TEXT,
  notify_url TEXT, return_url TEXT, contact_qq TEXT, contact_wechat TEXT, contact_phone TEXT,
  group_id TEXT, settle_type TEXT DEFAULT 'alipay', settle_account TEXT, settle_name TEXT,
  deposit REAL DEFAULT 0, today_income REAL DEFAULT 0, total_income REAL DEFAULT 0,
  today_orders INTEGER DEFAULT 0, total_orders INTEGER DEFAULT 0,
  last_login_at TEXT, last_login_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);`);
// 执行早期 0003 的重建序列
db.exec(rebuildSql);

const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
const replayedDdl = (row?.sql ?? '').trim();

const norm = (s) => s.replace(/\s+/g, ' ').replace(/"/g, '').trim();
const identical = norm(replayedDdl) === norm(prodDdl);
const hasQuotedName = replayedDdl.startsWith('CREATE TABLE "users"');
const hasInlineComments = /--/.test(replayedDdl);

console.log('=== 重建后 sqlite_master 中的 users DDL ===');
console.log(replayedDdl);
console.log('\n=== 与生产 DDL 对比 ===');
console.log('逐字符归一化后相同 :', identical);
console.log('表名带双引号        :', hasQuotedName);
console.log('保留行尾注释        :', hasInlineComments);
console.log('生产 DDL 归一化长度 :', norm(prodDdl).length);
console.log('重建 DDL 归一化长度 :', norm(replayedDdl).length);

writeFileSync(
  resolve(DIR, 'replayed-users-ddl.sql'),
  replayedDdl + '\n',
  'utf8'
);
writeFileSync(
  resolve(DIR, 'fingerprint-result.json'),
  JSON.stringify(
    {
      experiment: 'CREATE TABLE users_new -> DROP TABLE users -> ALTER TABLE users_new RENAME TO users',
      identical_to_prod: identical,
      table_name_quoted: hasQuotedName,
      inline_comments_preserved: hasInlineComments,
      prod_ddl_normalized_length: norm(prodDdl).length,
      replayed_ddl_normalized_length: norm(replayedDdl).length,
      prod_ddl: prodDdl,
      replayed_ddl: replayedDdl,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

db.close();
process.exit(identical ? 0 : 1);
