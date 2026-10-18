#!/usr/bin/env node
// 逐表比对「生产 D1 实际结构」与「仓库迁移链空库重放结构」，产出机器可读差异清单。
// 用法：node scripts/compare-schema-snapshots.mjs
// 输入：reports/schema-drift/prod-sqlite-master.json、reports/schema-drift/repo-replay-sqlite-master.json
// 输出：reports/schema-drift/schema-diff.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = resolve(ROOT, 'reports/schema-drift');

const load = (name) => {
  const raw = readFileSync(resolve(DIR, name), 'utf8');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed[0]?.results ?? [] : parsed?.results ?? [];
  return rows;
};

/** 从 CREATE TABLE 语句里抽出列名（只认顶层括号内的行首标识符） */
function extractColumns(sql) {
  if (!sql) return [];
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const cols = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) continue;
    // 跳过表级约束
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
    const m = /^["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC|BOOLEAN|DATE|TIMESTAMP)/i.exec(line);
    if (m) cols.push(m[1]);
  }
  return cols;
}

function indexSignature(sql) {
  if (!sql) return '';
  return sql.replace(/\s+/g, ' ').replace(/^CREATE (UNIQUE )?INDEX /i, 'INDEX ').trim();
}

/** D1/本地模拟的内部表，不属于业务结构，不参与比对 */
const INTERNAL_TABLES = new Set(['_cf_KV', '_cf_METADATA', '_cf_KV_journal']);

const build = (rows) => {
  const map = new Map();
  for (const r of rows) {
    if (r.type === 'table' && !r.name.startsWith('sqlite_') && !INTERNAL_TABLES.has(r.name)) {
      map.set(r.name, { sql: r.sql, columns: extractColumns(r.sql), indexes: [] });
    }
  }
  for (const r of rows) {
    if (r.type === 'index' && r.name && !r.name.startsWith('sqlite_')) {
      const table = rows.find((x) => x.type === 'index' && x.name === r.name)?.tbl_name;
      if (map.has(table)) map.get(table).indexes.push({ name: r.name, sig: indexSignature(r.sql) });
    }
  }
  return map;
};

const prod = build(load('prod-sqlite-master.json'));
const repo = build(load('repo-replay-sqlite-master.json'));

const tables = [];
for (const name of new Set([...prod.keys(), ...repo.keys()])) {
  const p = prod.get(name);
  const r = repo.get(name);
  const diffs = [];

  if (!p) {
    diffs.push({ kind: 'table_missing_in_prod', detail: `表 ${name} 存在于仓库重放结构，生产库中不存在` });
  } else if (!r) {
    diffs.push({ kind: 'table_missing_in_repo', detail: `表 ${name} 存在于生产库，仓库迁移链未创建` });
  } else {
    const pCols = p.columns;
    const rCols = r.columns;
    for (const c of rCols) if (!pCols.includes(c)) diffs.push({ kind: 'column_missing_in_prod', column: c, detail: `列 ${name}.${c} 在仓库定义中存在，生产库中缺失` });
    for (const c of pCols) if (!rCols.includes(c)) diffs.push({ kind: 'column_extra_in_prod', column: c, detail: `列 ${name}.${c} 生产库中存在，仓库定义中无此列` });
    if (pCols.length !== rCols.length && diffs.length === 0) {
      diffs.push({ kind: 'column_count_mismatch', detail: `列数不同：生产 ${pCols.length}，仓库 ${rCols.length}` });
    }
    const pIdx = new Set(p.indexes.map((i) => i.name));
    const rIdx = new Set(r.indexes.map((i) => i.name));
    for (const n of rIdx) if (!pIdx.has(n)) diffs.push({ kind: 'index_missing_in_prod', index: n, detail: `索引 ${n} 在仓库定义中存在，生产库中缺失` });
    for (const n of pIdx) if (!rIdx.has(n)) diffs.push({ kind: 'index_extra_in_prod', index: n, detail: `索引 ${n} 生产库中存在，仓库定义中无此索引` });
  }

  tables.push({
    name,
    in_prod: Boolean(p),
    in_repo: Boolean(r),
    prod_column_count: p ? p.columns.length : null,
    repo_column_count: r ? r.columns.length : null,
    prod_columns: p ? p.columns : null,
    repo_columns: r ? r.columns : null,
    identical: diffs.length === 0,
    diffs,
  });
}

tables.sort((a, b) => a.name.localeCompare(b.name));

const summary = {
  generated_by: 'scripts/compare-schema-snapshots.mjs',
  prod_source: 'wrangler d1 execute teaven-pay --remote (read-only, 2026-10-18)',
  repo_source: '本地空库按 0001→0008 顺序重放仓库 migrations/',
  prod_table_count: prod.size,
  repo_table_count: repo.size,
  tables_compared: tables.length,
  identical_tables: tables.filter((t) => t.identical).length,
  drifted_tables: tables.filter((t) => !t.identical).length,
  total_diffs: tables.reduce((n, t) => n + t.diffs.length, 0),
};

const out = { summary, tables };
mkdirSync(DIR, { recursive: true });
writeFileSync(resolve(DIR, 'schema-diff.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`prod tables=${summary.prod_table_count} repo tables=${summary.repo_table_count}`);
console.log(`compared=${summary.tables_compared} identical=${summary.identical_tables} drifted=${summary.drifted_tables} diffs=${summary.total_diffs}`);
for (const t of tables.filter((x) => !x.identical)) {
  console.log(`  [${t.name}] prod=${t.prod_column_count} repo=${t.repo_column_count}`);
  for (const d of t.diffs) console.log(`     - ${d.kind}: ${d.detail}`);
}
