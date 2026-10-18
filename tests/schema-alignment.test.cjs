/**
 * 0009 users 三列对齐迁移的自验  —— 任务 t-mv39kad0-1o8elj
 *
 * 覆盖：
 *   1. 目标列定义与 migrations/0001_initial.sql 第 15-17 行一致
 *   2. 生产 27 列结构 → 恰好加三列
 *   3. 仓库 30 列结构 → 一列都不加（不重复加列）
 *   4. 幂等：重复执行不报错、不再加列、列数不变
 *   5. 既有数据不被改写，新列为 NULL，api_key_type 默认 md5
 *   6. api_key 唯一语义生效：重复非空值被拒、多个 NULL 允许
 *   7. 加列不影响既有外键
 *
 * 运行：node --experimental-sqlite --test tests/schema-alignment.test.cjs
 *
 * 说明：沿用仓库既有的 node:test + node:sqlite 范式（同 credit-race.test.cjs），
 *   零额外依赖。vitest 无法解析 node:sqlite，故不用 vitest。
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(ROOT, "scripts", "lib", "align-users-columns.mjs"));

const COLS = ["api_key", "api_key_type", "rsa_public_key"];

// 生产 users 的真实结构（27 列，sqlite_master 中的原始 DDL）
const PROD_USERS_27 = `CREATE TABLE "users" (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'merchant',
    status INTEGER DEFAULT 1,
    balance REAL DEFAULT 0,
    frozen_balance REAL DEFAULT 0,
    notify_url TEXT,
    return_url TEXT,
    contact_qq TEXT,
    contact_wechat TEXT,
    contact_phone TEXT,
    group_id TEXT,
    settle_type TEXT DEFAULT 'alipay',
    settle_account TEXT,
    settle_name TEXT,
    deposit REAL DEFAULT 0,
    today_income REAL DEFAULT 0,
    total_income REAL DEFAULT 0,
    today_orders INTEGER DEFAULT 0,
    total_orders INTEGER DEFAULT 0,
    last_login_at TEXT,
    last_login_ip TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
)`;

// 仓库 0001_initial.sql 建出的结构（30 列，三列在中部）
const REPO_USERS_30 = `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'merchant',
    status INTEGER DEFAULT 1,
    balance REAL DEFAULT 0,
    frozen_balance REAL DEFAULT 0,
    api_key TEXT UNIQUE,
    api_key_type TEXT DEFAULT 'md5',
    rsa_public_key TEXT,
    notify_url TEXT,
    return_url TEXT,
    contact_qq TEXT,
    contact_wechat TEXT,
    contact_phone TEXT,
    group_id TEXT,
    settle_type TEXT DEFAULT 'alipay',
    settle_account TEXT,
    settle_name TEXT,
    deposit REAL DEFAULT 0,
    today_income REAL DEFAULT 0,
    total_income REAL DEFAULT 0,
    today_orders INTEGER DEFAULT 0,
    total_orders INTEGER DEFAULT 0,
    last_login_at TEXT,
    last_login_ip TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
)`;

function makeDb(usersSql) {
    const db = new DatabaseSync(":memory:");
    db.exec(usersSql);
    return db;
}

test("目标列定义与 0001_initial.sql 一致", () => {
    assert.deepStrictEqual(lib.TARGET_COLUMNS.map((c) => c.name), COLS);
    assert.strictEqual(lib.TARGET_COLUMNS[0].ddl, "api_key TEXT");
    assert.strictEqual(lib.TARGET_COLUMNS[1].ddl, "api_key_type TEXT DEFAULT 'md5'");
    assert.strictEqual(lib.TARGET_COLUMNS[2].ddl, "rsa_public_key TEXT");
});

test("生产 27 列结构：计划加三列", () => {
    const db = makeDb(PROD_USERS_27);
    assert.strictEqual(lib.currentUserColumns(db).length, 27);
    assert.deepStrictEqual(lib.planColumnAdds(db).map((c) => c.name), COLS);
    db.close();
});

test("仓库 30 列结构：计划为空（不重复加列）", () => {
    const db = makeDb(REPO_USERS_30);
    assert.strictEqual(lib.currentUserColumns(db).length, 30);
    assert.deepStrictEqual(lib.planColumnAdds(db), []);
    db.close();
});

test("执行后列数从 27 变 30，且含三列", () => {
    const db = makeDb(PROD_USERS_27);
    const executed = lib.applyColumnAdds(db);
    assert.deepStrictEqual(executed, COLS);
    const cols = lib.currentUserColumns(db);
    assert.strictEqual(cols.length, 30);
    for (const c of COLS) assert.ok(cols.includes(c), `缺少列 ${c}`);
    db.close();
});

test("幂等：重复执行不报错且不再加列", () => {
    const db = makeDb(PROD_USERS_27);
    lib.applyColumnAdds(db);
    assert.doesNotThrow(() => lib.applyColumnAdds(db));
    assert.deepStrictEqual(lib.applyColumnAdds(db), []);
    assert.strictEqual(lib.currentUserColumns(db).length, 30);
    db.close();
});

test("既有数据不被改写，新列为 NULL，api_key_type 默认 md5", () => {
    const db = makeDb(PROD_USERS_27);
    db.exec("INSERT INTO users (id, username, password_hash, salt, role) VALUES ('u1','shop','h','s','merchant');");
    lib.applyColumnAdds(db);
    const row = db
        .prepare("SELECT username, api_key, api_key_type, rsa_public_key FROM users WHERE id=?")
        .get("u1");
    assert.strictEqual(row.username, "shop");
    assert.strictEqual(row.api_key, null);
    assert.strictEqual(row.rsa_public_key, null);
    assert.strictEqual(row.api_key_type, "md5");
    db.close();
});

test("api_key 唯一语义生效：重复值被拒、多个 NULL 允许", () => {
    const db = makeDb(PROD_USERS_27);
    lib.applyColumnAdds(db);
    lib.ensureUniqueIndex(db);
    db.exec("INSERT INTO users (id, username, password_hash, salt, role) VALUES ('u1','a','h','s','merchant');");
    db.exec("INSERT INTO users (id, username, password_hash, salt, role) VALUES ('u2','b','h','s','merchant');");
    db.exec("INSERT INTO users (id, username, password_hash, salt, role, api_key) VALUES ('u3','c','h','s','merchant','k');");
    assert.throws(
        () =>
            db.exec(
                "INSERT INTO users (id, username, password_hash, salt, role, api_key) VALUES ('u4','d','h','s','merchant','k');"
            ),
        /UNIQUE/i
    );
    assert.ok(lib.UNIQUE_INDEX.ddl.includes("CREATE UNIQUE INDEX IF NOT EXISTS"));
    db.close();
});

test("加列不影响既有外键", () => {
    const db = makeDb(PROD_USERS_27);
    db.exec(
        "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, FOREIGN KEY (user_id) REFERENCES users(id));"
    );
    lib.applyColumnAdds(db);
    const fks = db.prepare("PRAGMA foreign_key_list('orders')").all();
    assert.ok(fks.some((f) => f.table === "users"), "orders 的外键应仍指向 users");
    db.close();
});

test("生产结构副本与仓库空库的 users 列集合一致（仅物理顺序不同）", () => {
    const dbA = makeDb(REPO_USERS_30);
    const dbB = makeDb(PROD_USERS_27);
    lib.applyColumnAdds(dbB);

    const a = lib.currentUserColumns(dbA);
    const b = lib.currentUserColumns(dbB);
    assert.strictEqual(a.length, 30);
    assert.strictEqual(b.length, 30);
    assert.deepStrictEqual([...a].sort(), [...b].sort());
    // SQLite 的 ALTER TABLE ADD COLUMN 只能追加到末尾，故顺序不同、集合相同
    assert.notDeepStrictEqual(a, b);

    dbA.close();
    dbB.close();
});
