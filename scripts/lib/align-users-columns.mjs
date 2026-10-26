// users 表三列对齐的纯逻辑（无 IO，可被脚本与测试复用）
//
// 背景（任务 t-mv39kad0-1o8elj）：
//   生产 D1 的 users 表缺 api_key / api_key_type / rsa_public_key 三列，
//   根因是 migrations/0003_api_keys.sql 早期版本的整表重建。
//   0009 迁移要把这三列加回，但 SQLite 的 DDL 不支持 IF NOT EXISTS 形式的
//   ADD COLUMN，重复执行会报 "duplicate column name"。
//   因此幂等性由「先读 PRAGMA table_info，再按需 ADD COLUMN」实现。

/** 目标列定义：与 migrations/0001_initial.sql 第 15-17 行一致 */
export const TARGET_COLUMNS = [
  { name: 'api_key', ddl: 'api_key TEXT' },
  { name: 'api_key_type', ddl: "api_key_type TEXT DEFAULT 'md5'" },
  { name: 'rsa_public_key', ddl: 'rsa_public_key TEXT' },
];

/** api_key 在 0001 中是 UNIQUE 列；SQLite 不允许 ADD COLUMN 带 UNIQUE，改用等价唯一索引 */
export const UNIQUE_INDEX = {
  name: 'idx_users_api_key',
  ddl: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key)',
};

/** 读取 users 表当前列名 */
export function currentUserColumns(db) {
  const rows = db.prepare("SELECT name FROM pragma_table_info('users')").all();
  return rows.map((r) => r.name);
}

/** 计算需要补哪些列（幂等核心：已存在的列不再动） */
export function planColumnAdds(db) {
  const existing = new Set(currentUserColumns(db));
  return TARGET_COLUMNS.filter((c) => !existing.has(c.name));
}

/** 按计划执行加列，返回实际执行的语句 */
export function applyColumnAdds(db) {
  const plan = planColumnAdds(db);
  const executed = [];
  for (const col of plan) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col.ddl}`);
    executed.push(col.name);
  }
  return executed;
}

/** 确保 api_key 的唯一索引存在（幂等） */
export function ensureUniqueIndex(db) {
  db.exec(UNIQUE_INDEX.ddl);
}
