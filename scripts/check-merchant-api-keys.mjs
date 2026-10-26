// 生产商户 API 密钥自检（只读）
//
// 背景（任务 t-mv39kakr-ojbnlu）：
//   生产 D1 曾出现 api_keys 表 0 行的情况：唯一商户（抹露茶柒）没有任何密钥，
//   于是 GET /pay/:merchantId 一律返回「商户未配置 API 密钥，暂无法下单」，
//   且所有支付 API（submit / refund / query / cashier）都无法通过验签。
//   根因不是密钥被清理，而是**从未生成过**：
//     - 0003_api_keys.sql 只迁移 `users.api_key IS NOT NULL` 的存量商户；
//     - 生产 users 表缺 api_key / api_key_type / rsa_public_key 三列（结构漂移，
//       根因见 migrations/0009_align_api_key_columns.sql 头部注释），
//       该迁移在生产上一条也插不进去；
//     - 商户创建于 2026-06-26，早于「创建商户即建默认密钥 + 登录自愈」上线，
//       两条路径都错过 → 有商户、无密钥。
//   后来由 ensureMerchantHasApiKey（src/routes/merchant.ts，登录自愈）补种了密钥。
//
//   这个故障的特征是「沉默」：库里没有数据，页面上只有一句文案，没有任何告警，
//   只有商户真的去下单时才会暴露。本脚本把它变成一条可以定期跑的断言。
//
// 做什么：
//   1. 列出所有 role='merchant' AND status=1 的商户 + 其启用密钥数量 / 类型 /
//      是否曾被使用（last_used_at），缺 key 的直接判 FAIL；
//   2. （--smoke）对真实站点做端到端冒烟：取收银台页 → 本地校验票据 HMAC →
//      用库里的密钥签名调 GET /api/pay/query 与 GET /api/pay/orders。
//      票据与签名都在本地算，不上行、不落盘。
//
// 只读保证：
//   - 数据库侧全部为 SELECT，wrangler 返回的 meta.changed_db 必须为 false、
//     rows_written 必须为 0，否则脚本直接报错退出；
//   - HTTP 侧除了 --real-order（默认关闭）只发 GET；
//   - 密钥一律掩码输出（前后各 4 位），绝不打印明文。
//
// 用法：
//   node scripts/check-merchant-api-keys.mjs                     # 只查库
//   node scripts/check-merchant-api-keys.mjs --smoke             # 库 + 端到端冒烟
//   node scripts/check-merchant-api-keys.mjs --smoke --real-order # 额外真下一单（会写库！）
//   BASE_URL=https://teaven-pay.moruteaven.workers.dev node scripts/check-merchant-api-keys.mjs --smoke
//
// 依赖：wrangler 已登录且当前目录的 wrangler.toml 指向目标 D1。
//      依次尝试 $WRANGLER_BIN、仓库 node_modules/.bin/wrangler.cmd、PATH 上的 wrangler。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DB_NAME = 'teaven-pay';

const args = new Set(process.argv.slice(2));
const SMOKE = args.has('--smoke');
const REAL_ORDER = args.has('--real-order');
const BASE_URL = (process.env.BASE_URL || 'https://teaven-pay.moruteaven.workers.dev').replace(/\/+$/, '');

/** 一句话诊断输出用的 ANSI 色（非 TTY 时自动失效） */
const useColor = process.stdout.isTTY !== false;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const OK = (t) => paint('32', t);
const BAD = (t) => paint('31', t);
const WARN = (t) => paint('33', t);
const DIM = (t) => paint('2', t);

// ---------------------------------------------------------------- wrangler 调用

function resolveWrangler() {
    const candidates = [
        process.env.WRANGLER_BIN,
        resolve(ROOT, 'node_modules', '.bin', 'wrangler.cmd'),
        resolve(ROOT, 'node_modules', '.bin', 'wrangler'),
        'wrangler',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate === 'wrangler') return candidate;
        if (existsSync(candidate)) return candidate;
    }
    throw new Error('找不到 wrangler：请安装依赖，或用 WRANGLER_BIN 指定路径');
}

const WRANGLER = resolveWrangler();

/**
 * 在目标 D1 上执行一条 SQL 并返回结果行。
 *
 * shell:true 是必须的：wrangler 在 Windows 上是 .cmd 批处理，
 * spawn 无法直接执行。内层双引号包住 SQL，避免空格与单引号被拆成多个参数。
 *
 * 带重试：Cloudflare API 偶发 fetch failed（本机代理/网络抖动都会触发），
 * 一次失败就把整轮自检判死会让这个脚本失去意义——它是要长期跑的哨兵，
 * 必须能扛住单点抖动。只对 network 类错误重试，业务错误立刻抛出。
 */
function d1(sql, attempt = 1) {
    let out;
    try {
        out = execFileSync(`"${WRANGLER}" d1 execute ${DB_NAME} --remote --json --command "${sql}"`, {
            cwd: ROOT,
            encoding: 'utf8',
            shell: true,
            maxBuffer: 32 * 1024 * 1024,
        });
    } catch (error) {
        if (attempt < 3) {
            const waitMs = 1000 * 2 ** (attempt - 1);
            console.log(DIM(`  wrangler 调用失败（第 ${attempt} 次）：${String(error.message).slice(0, 60)}… ${waitMs}ms 后重试`));
            execFileSync('ping -n 1 127.0.0.1', { shell: true, stdio: 'ignore' });
            return d1(sql, attempt + 1);
        }
        throw error;
    }

    const parsed = JSON.parse(out);
    const text = parsed.error?.text || '';
    if (text) {
        const transient = /fetch failed|network|timeout|ETIMEDOUT|ECONNRESET/i.test(text);
        if (transient && attempt < 3) {
            const waitMs = 1000 * 2 ** (attempt - 1);
            console.log(DIM(`  D1 返回临时错误（第 ${attempt} 次）：${text} — ${waitMs}ms 后重试`));
            execFileSync('ping -n 1 127.0.0.1', { shell: true, stdio: 'ignore' });
            return d1(sql, attempt + 1);
        }
        throw new Error(`wrangler d1 execute 失败：${text}`);
    }

    const meta = parsed[0]?.meta;
    if (meta && (meta.changed_db || (meta.rows_written ?? 0) > 0)) {
        throw new Error(`只读约束被破坏：changed_db=${meta.changed_db} rows_written=${meta.rows_written}`);
    }
    return parsed[0]?.results ?? [];
}

// ---------------------------------------------------------------- 密钥→签名工具
// 与 src/utils/crypto.ts、src/utils/cashierAuth.ts 保持同一套口径（= $(1)$ 是因为
// 这里要的是验签，必须与 Workers 侧逐字节一致）。

/** "\u001b[31m TODO \u001b[0m" */
function mask(secret) {
    if (!secret) return '(空)';
    const s = String(secret);
    return s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/**
 * 发一个 HTTP 请求并解析 JSON，带重试。
 *
 * 本机出口网络会周期性 ECONNRESET（代理/TLS 握手被掐），不重试的话
 * 脚本会把网络抖动误报成「支付链路故障」——这正是哨兵脚本最不该有的行为。
 */
async function request(url, init = {}, attempt = 1) {
    try {
        const res = await fetch(url, { redirect: 'manual', ...init });
        const body = await res.json();
        return { res, body };
    } catch (error) {
        if (attempt >= 3) throw error;
        const waitMs = 1000 * 2 ** (attempt - 1);
        console.log(DIM(`  HTTP 失败（第 ${attempt} 次）：${String(error.message).slice(0, 50)}… ${waitMs}ms 后重试`));
        await new Promise((r) => setTimeout(r, waitMs));
        return request(url, init, attempt + 1);
    }
}

/** 取回文本响应（收银台页），同样带重试 */
async function requestText(url, attempt = 1) {
    try {
        const res = await fetch(url, { redirect: 'manual' });
        return { res, text: await res.text() };
    } catch (error) {
        if (attempt >= 3) throw error;
        const waitMs = 1000 * 2 ** (attempt - 1);
        console.log(DIM(`  HTTP 失败（第 ${attempt} 次）：${String(error.message).slice(0, 50)}… ${waitMs}ms 后重试`));
        await new Promise((r) => setTimeout(r, waitMs));
        return requestText(url, attempt + 1);
    }
}

async function hmacSha256(key, message) {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
    return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 构造待签串：剔除空值/undefined 与 sign/sign_type，按字段名排序后 key=value 以 & 连接 */
function buildSignString(params) {
    return Object.keys(params)
        .filter((k) => params[k] !== '' && params[k] !== undefined && k !== 'sign' && k !== 'sign_type')
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&');
}

async function sign(params, key) {
    return hmacSha256(key, buildSignString(params));
}

// ---------------------------------------------------------------- 第 1 步：查库

console.log(`目标库：${DB_NAME}（remote）  wrangler：${WRANGLER}`);
console.log(DIM('—'.repeat(64)));

const merchants = d1(
    "SELECT id, username, status, created_at FROM users WHERE role = 'merchant' ORDER BY created_at"
);
const keyRows = d1(
    'SELECT user_id, id, api_key_type, status, last_used_at, created_at FROM api_keys ORDER BY created_at'
);

console.log(`商户总数：${merchants.length}（其中启用 ${merchants.filter((m) => m.status === 1).length}）`);
console.log(`api_keys 总行数：${keyRows.length}`);
console.log(DIM('—'.repeat(64)));

const failures = [];
const warnings = [];

for (const m of merchants) {
    const own = keyRows.filter((k) => k.user_id === m.id);
    const active = own.filter((k) => k.status === 1);
    const line = [`${m.username}  ${DIM(m.id)}`];

    if (m.status !== 1) {
        line.push(DIM('已停用，跳过密钥检查'));
        console.log(line.join('  '));
        continue;
    }

    if (active.length === 0) {
        line.push(BAD(`FAIL 无启用密钥（历史记录 ${own.length} 条）→ 收银台与支付 API 不可用`));
        failures.push(`${m.username}: 无启用密钥`);
    } else if (active.length > 1) {
        line.push(WARN(`${active.length} 把启用密钥（主密钥 = 创建最早的一条）`));
        warnings.push(`${m.username}: ${active.length} 把启用密钥`);
    } else {
        line.push(OK('OK 1 把启用密钥'));
    }
    line.push(DIM(`type=${active[0]?.api_key_type ?? '-'} last_used=${active[0]?.last_used_at ?? '从未'}`));
    console.log(line.join('  '));
}

// api_keys 表为空、或有孤儿密钥（商户已不存在）
const orphanKeys = keyRows.filter((k) => !merchants.some((m) => m.id === k.user_id));
if (keyRows.length === 0) {
    failures.push('api_keys 表 0 行：任何商户都无法下单与验签');
} else if (orphanKeys.length > 0) {
    warnings.push(`${orphanKeys.length} 条孤儿密钥（user_id 在 users 中不存在）`);
    console.log(WARN(`孤儿密钥：${orphanKeys.length} 条`));
}

// users 三列漂移复查：它决定了 0003 能否重放，是本次故障的根因之一
const userCols = d1("SELECT name FROM pragma_table_info('users')").map((r) => r.name);
const legacyCols = ['api_key', 'api_key_type', 'rsa_public_key'].filter((c) => userCols.includes(c));
if (legacyCols.length !== 3) {
    warnings.push(
        `users 缺 ${3 - legacyCols.length} 个旧密钥列（0009 未执行）→ 0003 存量迁移不可重放`
    );
    console.log(WARN(`users 旧密钥列：仅 ${legacyCols.length}/3 存在（0009 尚未在生产执行）`));
} else {
    console.log(OK('users 旧密钥列 3/3 齐备（0009 已生效）'));
}

// ---------------------------------------------------------------- 第 2 步：冒烟

if (!SMOKE) {
    report();
}

console.log(DIM('—'.repeat(64)));
console.log(`冒烟目标：${BASE_URL}`);

const targets = merchants.filter((m) => m.status === 1 && keyRows.some((k) => k.user_id === m.id && k.status === 1));
if (targets.length === 0) {
    fail('没有可冒烟的商户（全部缺启用密钥），跳过 HTTP 检查');
    report();
}

for (const merchant of targets) {
    const record = d1(
        `SELECT id, api_key, api_key_type FROM api_keys WHERE user_id = '${merchant.id}' AND status = 1 ORDER BY created_at ASC, id ASC LIMIT 1`
    )[0];
    const key = record.api_key;
    console.log(`\n${merchant.username}  主密钥 ${mask(key)}  type=${record.api_key_type}`);

    await checkCashierPage(merchant, key);
    await checkQuery(merchant, key);
    await checkOrders(merchant, key);
    if (REAL_ORDER) await placeOrder(merchant, key);
}

report();

// ---------------------------------------------------------------- 检查子过程

/** GET /pay/:merchantId：收银台页必须出来，且票据要用库里那把主密钥签出来 */
async function checkCashierPage(merchant, key) {
    const { res, text: html } = await requestText(`${BASE_URL}/pay/${merchant.id}`);

    if (res.status !== 200) return fail(`收银台页 HTTP ${res.status}`);
    if (html.includes('商户未配置 API 密钥')) return fail('收银台页仍提示「商户未配置 API 密钥」');
    if (html.includes('商户不存在或已停用')) return fail('收银台页提示「商户不存在或已停用」');

    const matched = /var cashierTicket = "([^"]+)"/.exec(html);
    if (!matched) return fail('收银台页未签发 cashierTicket');

    const ticket = matched[1];
    const parts = ticket.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return fail(`票据格式异常：${ticket.slice(0, 24)}…`);

    const expected = await hmacSha256(key, parts.slice(0, 4).join('.'));
    if (expected !== parts[4]) return fail('票据 HMAC 与库中主密钥不一致（签发用了别的密钥）');

    const expiresAt = Number(parts[3]);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return fail('票据已过期');

    pass(`收银台页 ${res.status}（${html.length}B），票据 HMAC 校验通过，${Math.round((expiresAt - Date.now()) / 1000)}s 后过期`);
}

/** GET /api/pay/query：用主密钥签名，必须验签通过 */
async function checkQuery(merchant, key) {
    const url = new URL(`${BASE_URL}/api/pay/query`);
    const timestamp = String(Date.now());

    // 借 /api/pay/orders 拿一笔真实单号，避免依赖写库
    const ordersUrl = new URL(`${BASE_URL}/api/pay/orders`);
    ordersUrl.search = new URLSearchParams({
        pid: merchant.id,
        limit: '1',
        offset: '0',
        timestamp,
        sign: await sign({ pid: merchant.id, limit: '1', offset: '0', timestamp }, key),
    }).toString();
    const { body: orders } = await request(ordersUrl);

    if (orders.code !== 1) return fail(`query 前置：/api/pay/orders 失败 code=${orders.code} ${orders.msg ?? ''}`);

    const tradeNo = orders.data?.[0]?.trade_no;
    if (!tradeNo) {
        console.log(DIM('  跳过 /api/pay/query：该商户还没有任何订单可查'));
        return;
    }

    url.search = new URLSearchParams({
        pid: merchant.id,
        trade_no: tradeNo,
        timestamp,
        sign: await sign({ pid: merchant.id, trade_no: tradeNo, timestamp }, key),
    }).toString();
    const { body: result } = await request(url);
    if (result.code !== 1) return fail(`/api/pay/query code=${result.code} ${result.msg ?? ''}`);

    // 负向对照：错密钥必须被拒，否则说明验签根本没生效
    const badUrl = new URL(`${BASE_URL}/api/pay/query`);
    badUrl.search = new URLSearchParams({
        pid: merchant.id,
        trade_no: tradeNo,
        timestamp,
        sign: await sign({ pid: merchant.id, trade_no: tradeNo, timestamp }, 'wrong-key-should-be-rejected'),
    }).toString();
    const { body: bad } = await request(badUrl);
    if (bad.code === 1) return fail('/api/pay/query 错密钥竟然通过（验签未生效！）');
    if (bad.code !== -2) return fail(`/api/pay/query 错密钥返回意外码 ${bad.code} ${bad.msg ?? ''}`);

    // 负向对照：过期时间戳
    const staleUrl = new URL(`${BASE_URL}/api/pay/query`);
    const staleTs = String(Date.now() - 600_000);
    staleUrl.search = new URLSearchParams({
        pid: merchant.id,
        trade_no: tradeNo,
        timestamp: staleTs,
        sign: await sign({ pid: merchant.id, trade_no: tradeNo, timestamp: staleTs }, key),
    }).toString();
    const { body: stale } = await request(staleUrl);
    if (stale.code === 1) return fail('/api/pay/query 过期时间戳竟然通过（重放未拦截！）');

    pass(`/api/pay/query ${result.trade_no} code=1 succ；错密钥 → ${bad.code}；过期时间戳 → ${stale.code}`);
}

/** GET /api/pay/orders：签名查询必须返回 count>0 的业务数据 */
async function checkOrders(merchant, key) {
    const timestamp = String(Date.now());
    const params = { pid: merchant.id, limit: '5', offset: '0', timestamp };

    const url = new URL(`${BASE_URL}/api/pay/orders`);
    url.search = new URLSearchParams({ ...params, sign: await sign(params, key) }).toString();
    const { body: result } = await request(url);
    if (result.code !== 1) return fail(`/api/pay/orders code=${result.code} ${result.msg ?? ''}`);

    // 负向对照：URL query 里的明文 key 必须不被接受（新版不读 query）
    const legacy = new URL(`${BASE_URL}/api/pay/orders`);
    legacy.search = new URLSearchParams({ pid: merchant.id, limit: '5', offset: '0', key }).toString();
    const { body: rejected } = await request(legacy);
    if (rejected.code === 1) return fail('/api/pay/orders 竟然接受 URL query 明文 key（密钥会进日志！）');

    pass(`/api/pay/orders count=${result.count} code=1；URL 明文 key → ${rejected.code}（已不读 query）`);
}

/**
 * POST /api/pay/cashier：真下一单，验证「收银台可下单」这条主链路（会写库）。
 * 默认关闭，只由 --real-order 触发。
 *
 * 下完会立刻用 /api/pay/close 把订单关掉，并把库中状态核到 3（已关闭）：
 * 证据要留下，垃圾不要留下——否则每验证一次就多一笔无人支付的挂单。
 */
async function placeOrder(merchant, key) {
    // 支付方式不能写死：/api/pay/cashier 的 type 是 payment_types.id（如 pt_wxpay），
    // 而且只有挂了启用通道的支付方式才能下单。这里从库里挑一个真正可用的，
    // 顺便把它本身当作一项配置断言——一个都挑不出来说明商户根本没法收款。
    // 注意：d1() 把整条 SQL 塞进 shell 的双引号里传，SQL 里不能有多余换行。
    const payable = d1(
        "SELECT pt.id FROM payment_types pt INNER JOIN channels c ON c.payment_type_id = pt.id AND c.status = 1 GROUP BY pt.id ORDER BY pt.sort_order LIMIT 1"
    );
    if (payable.length === 0) return fail('没有任何挂了启用通道的支付方式，收银台必然不可下单');

    const timestamp = String(Date.now());
    const body = { merchant_id: merchant.id, amount: '0.01', type: payable[0].id, name: 'API密钥自检', timestamp };

    // 正例：正确签名 → 必须下单成功
    // 下单是写操作，不能让网络重试把它重放成两笔单：只请求一次，失败即 FAIL。
    const res = await fetch(`${BASE_URL}/api/pay/cashier`, {
        method: 'POST',
        body: new URLSearchParams({ ...body, sign: await sign(body, key) }),
        redirect: 'manual',
    });
    const result = await res.json();
    if (result.code !== 1) return fail(`/api/pay/cashier 下单失败 code=${result.code} ${result.msg ?? ''}`);

    const tradeNo = result.trade_no;
    if (!tradeNo) return fail('/api/pay/cashier 未返回 trade_no');
    pass(`/api/pay/cashier 下单成功 trade_no=${tradeNo} amount=0.01`);

    // 落库核对：订单真的进了 orders 表，金额与状态都对得上
    const rows = d1(
        `SELECT id, status, amount, out_trade_no, payment_type FROM orders WHERE id = '${tradeNo}'`
    );
    if (rows.length !== 1) return fail(`orders 表查不到新订单 ${tradeNo}`);
    if (Number(rows[0].amount) !== 0.01) return fail(`订单金额不符：期望 0.01，实际 ${rows[0].amount}`);
    if (rows[0].status !== 0) return fail(`新订单状态应为 0（未支付），实际 ${rows[0].status}`);
    pass(`orders 落库核对通过：status=0 amount=${rows[0].amount} out_trade_no=${rows[0].out_trade_no}`);

    // 负例：篡改金额但沿用旧签名 → 必须被拒（-2 签名验证失败）
    const { body: tamperedResult } = await request(`${BASE_URL}/api/pay/cashier`, {
        method: 'POST',
        body: new URLSearchParams({ ...body, amount: '0.02', sign: await sign(body, key) }),
    });
    if (tamperedResult.code === 1) return fail('/api/pay/cashier 篡改金额竟然通过（签名未覆盖 amount！）');
    pass(`篡改金额 → code=${tamperedResult.code} ${tamperedResult.msg ?? ''}（签名确实覆盖金额）`);

    // 收尾：关掉这单，别留下未支付的挂单
    // 注意：/api/pay/close 成功返回 code=0，与查询类接口的 code=1 不同
    //（src/routes/pay.ts 里关闭分支写的是 code: 0）。这里以库中状态为准，不迷信返回码。
    const closeBody = { pid: merchant.id, trade_no: tradeNo };
    const { body: closed } = await request(`${BASE_URL}/api/pay/close`, {
        method: 'POST',
        body: new URLSearchParams({ ...closeBody, sign: await sign(closeBody, key) }),
    });
    if (closed.code !== 0) {
        warnings.push(`测试订单 ${tradeNo} 未能关闭（code=${closed.code}），需人工处理`);
        console.log(`  ${WARN('!')} 测试订单未能关闭 code=${closed.code} ${closed.msg ?? ''}，请人工关闭`);
        return;
    }

    const after = d1(`SELECT status FROM orders WHERE id = '${tradeNo}'`);
    if (after[0]?.status !== 3) {
        warnings.push(`测试订单 ${tradeNo} 关闭后状态为 ${after[0]?.status}，期望 3`);
        return;
    }
    console.log(`  ${DIM('·')} 测试订单已关闭（status=3），未留下未支付挂单`);
}

// ---------------------------------------------------------------- 输出与退出码

function pass(message) {
    console.log(`  ${OK('✓')} ${message}`);
}

function fail(message) {
    console.log(`  ${BAD('✗')} ${message}`);
    failures.push(message);
    return false;
}

function report() {
    console.log(DIM('—'.repeat(64)));
    if (warnings.length > 0) {
        console.log(`${WARN('警告')} ${warnings.length} 条：`);
        for (const w of warnings) console.log(`  - ${w}`);
    }
    if (failures.length > 0) {
        console.log(`${BAD('失败')} ${failures.length} 条：`);
        for (const f of failures) console.log(`  - ${f}`);
        console.log(BAD('\n结论：存在商户无法下单或无法通过验签，需按 docs/api-key-recovery.md 处置。'));
        process.exit(1);
    }
    console.log(OK('结论：全部启用商户都有可用密钥，收银台与签名链路正常。'));
    process.exit(0);
}
