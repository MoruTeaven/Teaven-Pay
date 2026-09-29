/**
 * 入账竞态（双重入账）与回调金额核对自验  —— DoD 5
 *
 * 用真实 SQLite（node:sqlite）跑真实 SQL，驱动 src/utils/credit.ts 的编译产物，
 * 覆盖两条入账路径（渠道回调 notify / 收银台轮询 status）：
 *   1. 双回调并发：只入账一次
 *   2. 两个独立连接（模拟两个 Worker 实例）并发：只入账一次
 *   3. 回调 + 收银台轮询交错：只入账一次
 *   4. 实付金额与订单金额不一致 / 金额缺失：拒绝入账并留审计日志
 *   5. 入账事务中途失败：余额与流水都不留痕，订单回退可重试
 *   6. 回归对照：修复前的 SQL 序列确实会双倍入账（证明缺陷真实存在）
 *
 * 运行：node --experimental-sqlite --test tests/credit-race.test.cjs
 *
 * 说明：仓库 package.json 的 test 脚本指向 vitest，但当前仓库没有 vitest 配置与用例；
 *   这里用 Node 内置 test runner + node:sqlite，零额外依赖，可直接自验。
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
const BUILD_DIR = path.join(ROOT, "tests", ".tmp", "build");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

// ---------- 1. 把待验证的 TS 源码编译成可 require 的 JS ----------
function buildSource() {
    const outFile = path.join(BUILD_DIR, "utils", "credit.js");
    const args = [
        "--module", "commonjs",
        "--moduleResolution", "node10",
        "--target", "es2022",
        "--lib", "es2022",
        "--types", "@cloudflare/workers-types,node",
        "--esModuleInterop", "true",
        "--skipLibCheck", "true",
        "--strict", "true",
        "--outDir", BUILD_DIR,
        path.join("src", "utils", "credit.ts"),
    ];
    const compileCmd = "node node_modules/typescript/bin/tsc " + args.join(" ");

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
        // 仓库 src/utils/uuid.ts 有一处与本修复无关的既有类型报错（TS2365，tsc 仍会产出 JS），
        // 这里排除它，其余诊断一律视为编译失败。
        const known = /src[\\/]utils[\\/]uuid\.ts.*TS2365/;
        const unknown = diagnostics.split("\n").filter((line) => line.indexOf("error TS") >= 0 && !known.test(line));
        if (unknown.length || !fs.existsSync(outFile)) {
            throw new Error("编译 src/utils/credit.ts 失败：\n" + diagnostics);
        }
    }

    if (!fs.existsSync(outFile)) {
        throw new Error("缺少编译产物 " + outFile + "\n请先执行：" + compileCmd);
    }
    return require(outFile);
}

const credit = buildSource();
const { creditOrder, CREDIT_OUTCOME, CREDIT_SOURCE, matchOrderAmount } = credit;

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

const Q = String.fromCharCode(39); // 单引号
const SCHEMA = [
    "CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, status INTEGER DEFAULT 1,",
    "  balance REAL DEFAULT 0, today_income REAL DEFAULT 0, total_income REAL DEFAULT 0,",
    "  today_orders INTEGER DEFAULT 0, total_orders INTEGER DEFAULT 0);",
    "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, out_trade_no TEXT,",
    "  payment_type TEXT, channel_id TEXT, plugin TEXT, amount REAL NOT NULL, actual_amount REAL,",
    "  fee REAL DEFAULT 0, profit REAL DEFAULT 0, status INTEGER DEFAULT 0, name TEXT, param TEXT,",
    "  buyer TEXT, api_trade_no TEXT, notify_url TEXT, notify_status INTEGER DEFAULT 0,",
    "  notify_count INTEGER DEFAULT 0, created_at TEXT, paid_at TEXT, closed_at TEXT);",
    "CREATE TABLE order_logs (id TEXT PRIMARY KEY, order_id TEXT, user_id TEXT, out_trade_no TEXT,",
    "  action TEXT, from_status INTEGER, to_status INTEGER, amount REAL, detail TEXT,",
    "  ip TEXT, user_agent TEXT, created_at TEXT);",
    "CREATE TABLE payment_logs (id TEXT PRIMARY KEY, order_id TEXT, user_id TEXT, channel_id TEXT,",
    "  plugin TEXT, direction TEXT, action TEXT, status TEXT, amount REAL, third_party_trade_no TEXT,",
    "  request_data TEXT, response_data TEXT, error_message TEXT, created_at TEXT);",
].join("\n");

const AMOUNT = 77.77;
const FEE = 1.77;
const PROFIT = AMOUNT - FEE;
const MERCHANT = "m777";
const ORDER_ID = "t777";

function seed(db) {
    db.exec(SCHEMA);
    db.prepare("INSERT INTO users (id, role, status) VALUES (?, ?, 1)").run(MERCHANT, "merchant");
    db.prepare("INSERT INTO orders (id, user_id, out_trade_no, payment_type, channel_id, plugin, amount, fee, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(ORDER_ID, MERCHANT, "out-777", "xunhupay", "c777", "xunhupay", AMOUNT, FEE, 0);
}

function freshDb() {
    const file = path.join(os.tmpdir(), "teaven-credit-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".sqlite");
    const db = new DatabaseSync(file);
    seed(db);
    return { db, file };
}

const readOrder = (db) => db.prepare("SELECT * FROM orders WHERE id = ?").get(ORDER_ID);
const readUser = (db) => db.prepare("SELECT * FROM users WHERE id = ?").get(MERCHANT);
const countWhere = (db, table, where) => db.prepare("SELECT COUNT(*) AS n FROM " + table + " WHERE " + where).get().n;

function notifyParams(extra) {
    return Object.assign(
        { tradeNo: ORDER_ID, thirdPartyTradeNo: "TXN-777", buyer: "buyer-7", paidAt: "2026-06-29T07:07:07.777Z", paidAmount: AMOUNT },
        extra || {}
    );
}

// ---------- 3. 用例 ----------

test("双回调并发：同一订单只入账一次", async () => {
    const { db, file } = freshDb();
    try {
        const snapA = readOrder(db);
        const snapB = readOrder(db); // 与 A 完全相同的未支付快照 = 原缺陷的竞态入口
        const results = await Promise.all([
            creditOrder({ DB: makeD1(db) }, snapA, notifyParams(), CREDIT_SOURCE.CHANNEL_NOTIFY),
            creditOrder({ DB: makeD1(db) }, snapB, notifyParams(), CREDIT_SOURCE.CHANNEL_NOTIFY),
        ]);
        const credited = results.filter((r) => r.outcome === CREDIT_OUTCOME.CREDITED);
        assert.strictEqual(credited.length, 1, "两次回调必须恰好一次 credited: " + JSON.stringify(results.map((r) => r.outcome)));
        assert.strictEqual(results.find((r) => r.outcome !== CREDIT_OUTCOME.CREDITED).outcome, CREDIT_OUTCOME.DUPLICATE);
        assert.ok(Math.abs(readUser(db).balance - PROFIT) < 1e-9, "余额只应增加一次利润，实际=" + readUser(db).balance);
        assert.strictEqual(readUser(db).total_orders, 1);
        assert.strictEqual(readUser(db).today_orders, 1);
        assert.strictEqual(countWhere(db, "order_logs", "action = " + Q + "paid" + Q), 1, "只应有一条 paid 流水");
        assert.strictEqual(countWhere(db, "payment_logs", "status = " + Q + "success" + Q), 1);
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("两个独立连接的并发回调：仍只入账一次", async () => {
    const file = path.join(os.tmpdir(), "teaven-credit-two-" + Date.now() + ".sqlite");
    const a = new DatabaseSync(file);
    seed(a);
    const b = new DatabaseSync(file);
    try {
        const r1 = await creditOrder({ DB: makeD1(a) }, readOrder(a), notifyParams(), CREDIT_SOURCE.CHANNEL_NOTIFY);
        const r2 = await creditOrder({ DB: makeD1(b) }, readOrder(b), notifyParams(), CREDIT_SOURCE.CHANNEL_NOTIFY);
        assert.strictEqual(r1.outcome, CREDIT_OUTCOME.CREDITED);
        assert.strictEqual(r2.outcome, CREDIT_OUTCOME.DUPLICATE, "另一个 Worker 实例不得再次入账");
        assert.ok(Math.abs(readUser(b).balance - PROFIT) < 1e-9);
    } finally { a.close(); b.close(); fs.rmSync(file, { force: true }); }
});

test("回调 + 收银台轮询交错：只入账一次", async () => {
    const { db, file } = freshDb();
    try {
        const staleSnap = readOrder(db); // 两条路径都基于同一份未支付快照
        const poll = await creditOrder({ DB: makeD1(db) }, staleSnap, notifyParams({ thirdPartyTradeNo: "TXN-POLL" }), CREDIT_SOURCE.STATUS_POLL);
        const notify = await creditOrder({ DB: makeD1(db) }, staleSnap, notifyParams({ thirdPartyTradeNo: "TXN-NOTIFY" }), CREDIT_SOURCE.CHANNEL_NOTIFY);
        assert.strictEqual(poll.outcome, CREDIT_OUTCOME.CREDITED);
        assert.strictEqual(notify.outcome, CREDIT_OUTCOME.DUPLICATE);
        assert.ok(Math.abs(readUser(db).balance - PROFIT) < 1e-9);
        assert.strictEqual(countWhere(db, "order_logs", "action = " + Q + "paid" + Q), 1);
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("实付金额与订单金额不一致：拒绝入账、订单不变、留下审计日志", async () => {
    const { db, file } = freshDb();
    try {
        const result = await creditOrder({ DB: makeD1(db) }, readOrder(db), notifyParams({ paidAmount: 0.01 }), CREDIT_SOURCE.CHANNEL_NOTIFY);
        assert.strictEqual(result.outcome, CREDIT_OUTCOME.AMOUNT_MISMATCH);
        assert.strictEqual(readOrder(db).status, 0, "金额不符时订单必须保持未支付");
        assert.strictEqual(readUser(db).balance, 0, "金额不符时不得加余额");
        assert.strictEqual(countWhere(db, "order_logs", "action = " + Q + "credit_rejected" + Q), 1);
        assert.strictEqual(countWhere(db, "payment_logs", "status = " + Q + "rejected" + Q), 1);
        const msg = db.prepare("SELECT error_message FROM payment_logs WHERE status = " + Q + "rejected" + Q).get().error_message;
        assert.ok(/金额超出容差/.test(msg), "日志需说明超出容差: " + msg);
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("渠道未回传实付金额：无法核对 → 放行入账但留 warning 流水（决策 2026-09-29）", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        const r1 = await creditOrder({ DB: d1 }, readOrder(db), notifyParams({ paidAmount: undefined }), CREDIT_SOURCE.CHANNEL_NOTIFY);
        assert.strictEqual(r1.outcome, CREDIT_OUTCOME.CREDITED, "缺金额不得阻断入账");
        assert.strictEqual(readOrder(db).status, 1);
        assert.strictEqual(readUser(db).balance, PROFIT, "仍按订单额入账");
        assert.ok(Math.abs(readOrder(db).actual_amount - AMOUNT) < 1e-9, "未核实时 actual_amount 记订单额，不编造实付");
        const warn = db.prepare("SELECT * FROM payment_logs WHERE status = " + Q + "warning" + Q).get();
        assert.ok(warn, "必须留下未核对的 warning 流水");
        assert.strictEqual(JSON.parse(warn.response_data).amount_verified, false);
        assert.strictEqual(JSON.parse(warn.response_data).paid_cents, null, "没有实付就不得伪造 paid_cents");
        assert.strictEqual(countWhere(db, "payment_logs", "status = " + Q + "success" + Q), 1);
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("金额核对容差 ±0.70 元：边界内放行、超出即拒", () => {
    assert.strictEqual(matchOrderAmount(77.77, 77.77).ok, true, "完全相等必须通过");
    assert.strictEqual(matchOrderAmount(77.77, 77.07).ok, true, "少付 0.70 元(70 分)在容差内");
    assert.strictEqual(matchOrderAmount(77.77, 78.47).ok, true, "多付 0.70 元(70 分)在容差内");
    assert.strictEqual(matchOrderAmount(77.77, 77.06).ok, false, "少付 0.71 元(71 分)必须拒绝");
    assert.strictEqual(matchOrderAmount(77.77, 78.48).ok, false, "多付 0.71 元(71 分)必须拒绝");
    assert.strictEqual(matchOrderAmount(77.77, 0.01).ok, false, "付 0.01 顶全额订单必须拒绝");
    const w = matchOrderAmount(77.77, 77.07);
    assert.strictEqual(w.diffCents, 70, "差额要按分报出");
    assert.ok(w.warning && /容差内放行/.test(w.warning), "容差内差额必须带 warning");
    assert.strictEqual(matchOrderAmount(77.77, 77.77).warning, undefined, "零差额不该有 warning");
    assert.strictEqual(matchOrderAmount(77.77, 77.77).verified, true, "比对通过要标 verified");
    assert.strictEqual(matchOrderAmount(77.77, 77.07).verified, true, "容差内放行同样是已核对");
    const missing = matchOrderAmount(77.77, undefined);
    assert.strictEqual(missing.ok, true, "渠道未回传金额改为放行");
    assert.strictEqual(missing.verified, false, "放行但未核对要标出来");
    assert.ok(/无法核对/.test(missing.warning || ""), "缺金额必须带 warning 文案");
    assert.strictEqual(matchOrderAmount(77.77, null).ok, true, "null 同样视为未回传");
    assert.strictEqual(matchOrderAmount(0.1, 0.1).ok, true, "浮点表示误差不得误伤合法金额");
    assert.strictEqual(matchOrderAmount(1234.56, "1234.56").ok, true, "字符串金额同样可核对");
});

test("容差内差额：照常入账，但写 warning 流水、actual_amount 落实付", async () => {
    const { db, file } = freshDb();
    try {
        const result = await creditOrder({ DB: makeD1(db) }, readOrder(db), notifyParams({ paidAmount: 77.07 }), CREDIT_SOURCE.CHANNEL_NOTIFY);
        assert.strictEqual(result.outcome, CREDIT_OUTCOME.CREDITED, "容差内必须放行入账");
        assert.strictEqual(readUser(db).balance, PROFIT, "入账仍按订单额计算净额");
        assert.strictEqual(readOrder(db).status, 1);
        assert.ok(Math.abs(readOrder(db).actual_amount - 77.07) < 1e-9, "actual_amount 记录渠道实付");
        assert.strictEqual(countWhere(db, "payment_logs", "status = " + Q + "warning" + Q), 1, "容差放行要留 warning 流水");
        assert.strictEqual(countWhere(db, "payment_logs", "status = " + Q + "rejected" + Q), 0, "容差内不得记成拒绝");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("入账事务中途失败：余额与流水都不留痕，订单回退以便重试", async () => {
    const { db, file } = freshDb();
    try {
        const d1 = makeD1(db);
        d1.batch = async (statements) => {
            db.exec("BEGIN IMMEDIATE");
            statements[0]._exec(); // 余额已加，随后模拟 D1 事务失败
            db.exec("ROLLBACK");
            throw new Error("simulated D1 batch failure");
        };
        const result = await creditOrder({ DB: d1 }, readOrder(db), notifyParams(), CREDIT_SOURCE.CHANNEL_NOTIFY);
        assert.strictEqual(result.outcome, CREDIT_OUTCOME.DB_ERROR);
        assert.strictEqual(readOrder(db).status, 0, "入账失败必须回退订单状态，便于渠道重试");
        assert.strictEqual(readUser(db).balance, 0, "回滚后余额不变");
        assert.strictEqual(countWhere(db, "order_logs", "action = " + Q + "paid" + Q), 0, "回滚后不留成功流水");
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});

test("回归对照：修复前的 SQL 序列会双倍入账（证明缺陷真实存在）", async () => {
    const { db, file } = freshDb();
    try {
        // 复刻线上 bundle 7327-7386 的顺序：SELECT(WHERE status=0) -> 无守卫 UPDATE -> 无条件 balance +=
        async function legacyCredit(source) {
            const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 0").get(ORDER_ID);
            if (!order) return "skipped";
            db.prepare("UPDATE orders SET status = 1, api_trade_no = ?, paid_at = ?, notify_status = 0 WHERE id = ?")
                .run("TXN-" + source, new Date().toISOString(), ORDER_ID);
            const profit = order.amount - order.fee;
            db.prepare("UPDATE users SET balance = balance + ?, today_income = today_income + ?, total_income = total_income + ?, today_orders = today_orders + 1, total_orders = total_orders + 1 WHERE id = ?")
                .run(profit, profit, profit, order.user_id);
            return "credited";
        }
        const snapshot = readOrder(db);
        assert.strictEqual(snapshot.status, 0, "初始未支付");
        // 旧实现里两个并发请求都在 SELECT 阶段读到 status=0，然后各自无条件加钱
        assert.strictEqual(await legacyCredit("notify-1"), "credited");
        db.prepare("UPDATE orders SET status = 0 WHERE id = ?").run(ORDER_ID); // 模拟并发对手读到的仍是旧快照
        assert.strictEqual(await legacyCredit("notify-2"), "credited");
        const balance = readUser(db).balance;
        assert.ok(Math.abs(balance - PROFIT * 2) < 1e-9, "旧实现应复现双倍入账，实际余额=" + balance);
        assert.strictEqual(readUser(db).total_orders, 2);
    } finally { db.close(); fs.rmSync(file, { force: true }); }
});