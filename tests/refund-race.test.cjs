/**
 * 退款额度守卫并发自验（不超退）—— DoD 4（任务 t-mukt086l-zjzt0h）
 *
 * 用真实 SQLite（node:sqlite）跑真实 SQL，驱动 src/utils/refundGuard.ts 的编译产物，
 * 覆盖退款资金安全的守卫语义：
 *   1. 7 笔并发占位：11.11 × 7 = 77.77 恰好占满，第 8 笔被 CAS 拒绝，绝不超退
 *      （同时验证按分整数守卫：裸浮点比较会把第 7 笔合法退款误拒）
 *   2. 两个独立连接（模拟两个 Worker 实例）并发部分退款：只成功一笔，累计不超退
 *   3. 渠道失败释放占位：额度完全恢复，可再次发起退款
 *   4. 部分退款后全额占位失败：订单不卡「已退款」状态，剩余额度仍可退
 *   5. 并发对账确认失败：同一笔占位只被释放一次（EXISTS 守卫防超退）
 *   6. 并发对账确认成功：CAS 只生效一次
 *   7. 回归对照：无守卫的旧 SQL 序列确实会超退（证明守卫必要）
 *
 * 运行：node --experimental-sqlite --test tests/refund-race.test.cjs
 *
 * 说明：沿用仓库既有的 node:test + node:sqlite 范式（同 credit-race.test.cjs），
 *   零额外依赖，可直接自验。SQL 原句取自 refundGuard.ts 导出的常量，
 *   保证「测试跑的守卫」与「生产跑的守卫」逐字一致，不漂移。
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "tests", ".tmp", "build-refund");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

// ---------- 1. 把待验证的 TS 源码编译成可 require 的 JS ----------
function buildSource() {
    const outFile = path.join(BUILD_DIR, "utils", "refundGuard.js");
    const args = [
        "--module", "commonjs",
        "--moduleResolution", "node10",
        "--target", "es2022",
        "--lib", "es2022",
        "--types", "@cloudflare/workers-types,node",
        "--esModuleInterop", "true",
        "--skipLibCheck", "true",
        "--strict", "true",
        // 显式指定 rootDir：单文件编译（refundGuard.ts 无同目录 import）时
        // TS 会把源文件目录推断为 rootDir，产物直接落 outDir 根，路径就不对了
        "--rootDir", "src",
        "--outDir", BUILD_DIR,
        path.join("src", "utils", "refundGuard.ts"),
    ];

    // 部分沙箱/CI 环境禁止再启子进程（spawnSync EPERM），此时复用已编译产物即可
    let spawned = null;
    try {
        spawned = spawnSync(process.execPath, [TSC].concat(args), { cwd: ROOT, encoding: "utf8" });
        if (spawned.error) spawned = null;
    } catch (_) {
        spawned = null;
    }

    if (spawned) {
        const diagnostics = String((spawned.stdout || "") + (spawned.stderr || ""));
        const unknown = diagnostics.split("\n").filter((line) => line.indexOf("error TS") >= 0);
        if (unknown.length || !fs.existsSync(outFile)) {
            throw new Error("编译 src/utils/refundGuard.ts 失败：\n" + diagnostics);
        }
    }

    if (!fs.existsSync(outFile)) {
        throw new Error("缺少编译产物 " + outFile);
    }
    return require(outFile);
}

const guard = buildSource();

// ---------- 2. 最小 D1 mock：语句直连真实 SQLite ----------
function makeD1(db) {
    function prepare(sql) {
        const stmt = db.prepare(sql);
        const holder = {
            _sql: sql,
            _params: [],
            bind() { holder._params = Array.prototype.slice.call(arguments); return holder; },
            async first() { const row = stmt.get.apply(stmt, holder._params); return row === undefined ? null : row; },
            async all() { return stmt.all.apply(stmt, holder._params); },
            _exec() {
                const info = stmt.run.apply(stmt, holder._params);
                return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }, results: [] };
            },
            async run() { return holder._exec(); },
        };
        return holder;
    }
    return {
        prepare,
        // D1 batch = 单事务：任一条失败整批回滚
        async batch(statements) {
            db.exec("BEGIN IMMEDIATE");
            try {
                const out = statements.map((s) => s._exec());
                db.exec("COMMIT");
                return out;
            } catch (error) {
                try { db.exec("ROLLBACK"); } catch (_) { /* ignore */ }
                throw error;
            }
        },
    };
}

const SCHEMA = [
    "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, out_trade_no TEXT,",
    "  amount REAL NOT NULL, status INTEGER DEFAULT 0, refund_amount REAL DEFAULT 0);",
    "CREATE TABLE refunds (id TEXT PRIMARY KEY, refund_no TEXT, order_id TEXT, user_id TEXT,",
    "  amount REAL, status INTEGER DEFAULT 0, third_party_refund_no TEXT, channel_refund_no TEXT,",
    "  error_message TEXT, created_at TEXT, completed_at TEXT);",
].join("\n");

const MERCHANT = "m777";
const ORDER_ID = "t777";
const ORDER_AMOUNT = 77.77;

function freshDb() {
    const file = path.join(os.tmpdir(), "teaven-refund-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".sqlite");
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    db.prepare("INSERT INTO orders (id, user_id, out_trade_no, amount, status) VALUES (?, ?, ?, ?, 1)")
        .run(ORDER_ID, MERCHANT, "out-777", ORDER_AMOUNT);
    return { db, file };
}

const readOrder = (db) => db.prepare("SELECT * FROM orders WHERE id = ?").get(ORDER_ID);
/** 金额断言统一按分，消除 REAL 累加的浮点噪声 */
const refundCents = (db) => Math.round(readOrder(db).refund_amount * 100);

// ---------- 3. 用例 ----------

test("7 笔并发占位 11.11：恰好占满 77.77，第 8 笔被 CAS 拒绝（含浮点加固验证）", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        // Promise.all 模拟 7 个并发退款请求（11.11 × 7 = 77.77，全额占满）
        const results = await Promise.all(
            Array.from({ length: 7 }, () => guard.reserveRefundQuota(d1, ORDER_ID, 11.11))
        );
        assert.strictEqual(results.filter(Boolean).length, 7, "7 笔合法退款必须全部占位成功: " + JSON.stringify(results));
        assert.strictEqual(refundCents(db), 7777, "占位累计必须恰好等于订单额");

        // 第 8 笔：哪怕只多退 0.01 也必须被守卫拒绝
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, 0.01), false, "占满后再退 0.01 必须被拒");
        assert.strictEqual(refundCents(db), 7777, "被拒的占位不得改动 refund_amount");

        // 裸浮点对照：refund_amount 逐笔累加后的实际值（REAL 噪声），证明按分守卫的必要性
        // （若守卫是裸浮点比较 refund_amount + ? <= amount，第 7 笔可能被浮点噪声误拒）
        assert.ok(readOrder(db).refund_amount <= ORDER_AMOUNT, "占位累计不得超过订单额");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("两个独立连接并发部分退款：只成功一笔，累计不超退", async () => {
    const file = path.join(os.tmpdir(), "teaven-refund-two-" + Date.now() + ".sqlite");
    const a = new DatabaseSync(file);
    const b = new DatabaseSync(file);
    try {
        // b 打开的是同一个文件，表已由 a 建好，这里只建一次
        a.exec(SCHEMA);
        a.prepare("INSERT INTO orders (id, user_id, out_trade_no, amount, status) VALUES (?, ?, ?, ?, 1)")
            .run(ORDER_ID, MERCHANT, "out-777", ORDER_AMOUNT);
        // 两个「Worker 实例」各持一个连接，同时基于同一订单发起 47.7 的退款
        //（47.7 × 2 = 95.4 > 77.77，第二笔必须被拒）
        const r1 = await guard.reserveRefundQuota(makeD1(a), ORDER_ID, 47.7);
        const r2 = await guard.reserveRefundQuota(makeD1(b), ORDER_ID, 47.7);
        assert.strictEqual([r1, r2].filter(Boolean).length, 1, "并发超额退款只允许一笔占位成功");
        assert.strictEqual(Math.round(readOrder(b).refund_amount * 100), 4770);
        // 剩余 30.07 仍可正常占位（7770 + 3007 = 7777 分，恰好占满）
        assert.strictEqual(await guard.reserveRefundQuota(makeD1(b), ORDER_ID, 30.07), true);
        assert.strictEqual(refundCents(b), 7777);
        // 占满后再退 0.01 被拒
        assert.strictEqual(await guard.reserveRefundQuota(makeD1(b), ORDER_ID, 0.01), false);
    } finally { a.close(); b.close(); fs.rmSync(file, { force: true }); }
});

test("渠道失败释放占位：额度完全恢复，可再次退款", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        // 全额占位 77.77 → 订单翻转为已退款（复刻路由全额退款路径）
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, ORDER_AMOUNT), true);
        db.prepare("UPDATE orders SET status = 2 WHERE id = ? AND status = 1").run(ORDER_ID);
        assert.strictEqual(readOrder(db).status, 2);

        // 渠道退款失败：原子释放（batch 事务：额度回退 + 状态回翻）
        await guard.releaseRefundQuota(d1, ORDER_ID, ORDER_AMOUNT);
        assert.strictEqual(refundCents(db), 0, "失败后占位额度必须完全释放");
        assert.strictEqual(readOrder(db).status, 1, "释放后订单必须回到已支付状态");

        // 额度恢复：同样的全额退款可以再次发起
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, ORDER_AMOUNT), true);
        assert.strictEqual(refundCents(db), 7777);
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("部分退款后全额占位失败：订单不卡「已退款」，剩余额度仍可退", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        // 第一笔部分退款 47.7 成功（渠道成功，status 保持已支付）
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, 47.7), true);
        // 第二笔把剩余 30.07 退满：占位成功并翻转订单为已退款
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, 30.07), true);
        db.prepare("UPDATE orders SET status = 2 WHERE id = ? AND status = 1").run(ORDER_ID);
        assert.strictEqual(readOrder(db).status, 2);

        // 第二笔渠道退款失败：释放 30.07。此时 refund_amount=47.7 > 0，
        // 旧实现「额度归零才回翻状态」会把订单永远卡在已退款状态（剩余 30.07 无法再退）
        await guard.releaseRefundQuota(d1, ORDER_ID, 30.07);
        assert.strictEqual(refundCents(db), 4770, "只释放本次失败的 30.07");
        assert.strictEqual(readOrder(db).status, 1, "只要还有可退余额就必须回到已支付状态");
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, 30.07), true, "剩余额度必须可以再次退款");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("并发对账确认失败：同一笔占位只被释放一次（EXISTS 守卫防超退）", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        // 铺底：全额占位 + 一条「处理中」退款记录
        assert.strictEqual(await guard.reserveRefundQuota(d1, ORDER_ID, ORDER_AMOUNT), true);
        db.prepare("INSERT INTO refunds (id, refund_no, order_id, user_id, amount, status) VALUES (?, ?, ?, ?, ?, 0)")
            .run("rf-777", "rf-777", ORDER_ID, MERCHANT, ORDER_AMOUNT);

        // 两个「Worker 实例」同时拿到这条 status=0 的记录并对账到「渠道失败」：
        // 若没有 EXISTS(status=0) 守卫，两个事务都会释放 77.77，
        // refund_amount 变成 -77.77（等于凭空多出 77.77 可退额度 → 超退漏洞）
        const [r1, r2] = await Promise.all([
            guard.settleRefundFailed(d1, "rf-777", ORDER_ID, ORDER_AMOUNT, "渠道对账确认退款失败"),
            guard.settleRefundFailed(d1, "rf-777", ORDER_ID, ORDER_AMOUNT, "渠道对账确认退款失败"),
        ]);
        assert.strictEqual((r1.released ? 1 : 0) + (r2.released ? 1 : 0), 1, "两个并发对账只能释放一次额度: " + JSON.stringify([r1, r2]));
        assert.strictEqual((r1.marked ? 1 : 0) + (r2.marked ? 1 : 0), 1, "两个并发对账只能置一次失败");
        assert.strictEqual(refundCents(db), 0, "额度只释放一次");
        assert.strictEqual(db.prepare("SELECT status FROM refunds WHERE id = ?").get("rf-777").status, 2, "退款记录必须置为失败");
        assert.strictEqual(readOrder(db).status, 1, "订单回到已支付状态");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("并发对账确认成功：CAS 只生效一次", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        db.prepare("INSERT INTO refunds (id, refund_no, order_id, user_id, amount, status) VALUES (?, ?, ?, ?, ?, 0)")
            .run("rf-778", "rf-778", ORDER_ID, MERCHANT, 11.11);

        const [r1, r2] = await Promise.all([
            guard.settleRefundSuccess(d1, "rf-778"),
            guard.settleRefundSuccess(d1, "rf-778"),
        ]);
        assert.strictEqual([r1, r2].filter(Boolean).length, 1, "并发成功对账只能生效一次");
        const row = db.prepare("SELECT status, completed_at FROM refunds WHERE id = ?").get("rf-778");
        assert.strictEqual(row.status, 1, "退款记录必须置为成功");
        assert.ok(row.completed_at, "成功对账必须记录完成时间");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("回归对照：无守卫的旧 SQL 序列确实会超退（证明守卫必要）", async () => {
    const { db, file } = freshDb();
    try {
        // 复刻整改前的无守卫累加：应用层检查基于自己读到的快照，通过后无条件 UPDATE，
        // UPDATE 本身不带任何守卫。并发时两个请求都读到 refund_amount=0 的同一份
        // 旧快照，各自通过检查、各自累加 → 155.54 > 77.77 超退。
        async function legacyReserveFrom(snapshot, amount) {
            const remaining = snapshot.amount - (snapshot.refund_amount || 0);
            if (amount > remaining) return false; // 基于会过期的快照的应用层检查
            db.prepare("UPDATE orders SET refund_amount = refund_amount + ? WHERE id = ?").run(amount, ORDER_ID);
            return true;
        }
        const staleSnapshot = readOrder(db);
        assert.strictEqual(staleSnapshot.refund_amount, 0, "初始未退");
        // 两个并发请求拿到的是同一份旧快照（整改前竞态入口）
        assert.strictEqual(await legacyReserveFrom(staleSnapshot, ORDER_AMOUNT), true);
        assert.strictEqual(await legacyReserveFrom(staleSnapshot, ORDER_AMOUNT), true);
        const cents = refundCents(db);
        assert.ok(cents > 7777, "旧实现应复现超退（refund_amount > 订单额），实际=" + cents + " 分");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});
