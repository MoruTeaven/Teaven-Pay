// 在 D1 上幂等地给 refunds 加 channel_refund_no 列（任务 t-mukt086l-zjzt0h）
//
// 用法：
//   node scripts/apply-0010-refund-channel-no.mjs            # 仅打印将要执行的动作（干跑）
//   node scripts/apply-0010-refund-channel-no.mjs --apply    # 真正执行
//
// 说明：
//   SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
//   "duplicate column name"。本脚本先读 PRAGMA table_info 判断列是否存在，
//   再按需执行 ALTER TABLE，因此可重复运行（幂等）。
//
// 依赖：需要 wrangler 已登录到目标 Cloudflare 账号，且当前目录的 wrangler.toml
//       指向目标 D1（生产库 database_id = 7de39fde-b84c-46bd-bb0c-01004b6f5200）。
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const apply = process.argv.includes('--apply');
const DB_NAME = 'teaven-pay';
const TABLE = 'refunds';
const COLUMN = 'channel_refund_no';
const DDL = `ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`;

/**
 * 执行一条 SQL 并返回结果行。
 * 用 shell:true 把整条命令交给 cmd.exe 处理，内层双引号包住 SQL，
 * 防止 SQL 里的空格与单引号被拆成多个参数。
 * （--file 方式不返回结果行，故这里必须用 --command。）
 */
function d1(sql) {
  const cmd = `wrangler d1 execute ${DB_NAME} --remote --json --command "${sql}"`;
  const out = execFileSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  if (parsed.error) throw new Error(parsed.error.text || 'wrangler d1 execute 失败');
  return parsed[0]?.results ?? [];
}

console.log(apply ? '模式：实际执行（--apply）' : '模式：干跑（加 --apply 才会真正执行）');
console.log('目标库：', DB_NAME, '（remote）');

const cols = d1(`SELECT name FROM pragma_table_info('${TABLE}')`).map((r) => r.name);
console.log(`当前 ${TABLE} 列数：`, cols.length);

if (cols.includes(COLUMN)) {
  console.log(`${COLUMN} 已存在，无需加列。`);
} else {
  console.log(`需要加列：${COLUMN}`);
  if (!apply) {
    console.log('干跑结束。实际执行请加 --apply。');
  } else {
    console.log('执行：', DDL);
    d1(DDL);
    const after = d1(`SELECT name FROM pragma_table_info('${TABLE}')`).map((r) => r.name);
    console.log(`完成后 ${TABLE} 列数：`, after.length);
    console.log(`${COLUMN} 状态：exists=${after.includes(COLUMN)}`);
  }
}
