/**
 * 认证与密钥来源整改验证（任务 t-mukt085p）
 *
 * 覆盖三项问题：
 *   1) /api/pay/refund/query 原本只要 pid + 单号即可读退款记录（越权枚举）；
 *   2) 明文密钥可经 URL query（key=）传递，会泄露到日志 / CDN / Referer；
 *   3) 出站通知签名读 users.api_key 旧字段，与入站验签的 api_keys 表不同源，
 *      商户重置密钥后通知验签失败。
 */
import { describe, expect, it, vi } from 'vitest';
import { payRouter } from './pay';
import { Env } from '../types/env';
import {
    matchApiKey,
    readApiKeyFromHeaders,
    signOutboundPayload,
    resolveMerchantSigningKey,
} from '../utils/apiKeyAuth';
import { generateSignAsync, verifySignAsync } from '../utils/crypto';

const MERCHANT_ID = '01999999-aaaa-7bbb-8ccc-dddddddddddd';
const OTHER_MERCHANT_ID = '01999999-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const API_KEY = 'integration-test-api-key';
const NEW_API_KEY = 'rotated-test-api-key-777';

interface KeyRow {
    id: string;
    user_id: string;
    api_key: string;
    name: string;
    api_key_type: string;
    rsa_public_key: string | null;
    created_at: string;
}

/** 可变的假 api_keys 表：支持「重置密钥」场景 */
function createKeysStore() {
    const rows: KeyRow[] = [
        {
            id: 'key-1',
            user_id: MERCHANT_ID,
            api_key: API_KEY,
            name: '默认密钥',
            api_key_type: 'hmac-sha256',
            rsa_public_key: null,
            created_at: '2026-01-01T00:00:00.000Z',
        },
    ];
    return {
        rows,
        reset(newKey: string) {
            rows[0].api_key = newKey;
        },
    };
}

/** 最小 D1 替身：按 SQL 关键字返回预设结果 */
function createMockDb(store: ReturnType<typeof createKeysStore>, options: { refund?: any } = {}) {
    const prepare = (sql: string) => {
        const statement = {
            bind: (...args: any[]) => ({
                first: async () => {
                    if (sql.includes('FROM users')) {
                        const id = args[0];
                        if (id !== MERCHANT_ID && id !== OTHER_MERCHANT_ID) return null;
                        return { id, status: 1 };
                    }
                    if (sql.includes('FROM refunds')) {
                        return options.refund ?? null;
                    }
                    return null;
                },
                all: async () => {
                    if (sql.includes('FROM api_keys')) {
                        return { results: store.rows.filter((r) => r.user_id === args[0]) };
                    }
                    return { results: [] };
                },
                run: async () => ({ success: true, meta: { changes: 1 } }),
            }),
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        return statement;
    };
    return { prepare } as unknown as D1Database;
}

function createEnv(db: D1Database): Env {
    return { DB: db, ENVIRONMENT: 'test', DEFAULT_CURRENCY: 'CNY', LOG_LEVEL: 'info', ENABLE_CORS: 'false' } as unknown as Env;
}

function callPay(path: string, init: RequestInit = {}) {
    return payRouter.fetch(new Request(`https://pay.example.com${path}`, init), createEnv((init as any).__db));
}

/** 带 mock DB 的路由调用 */
function callWithDb(db: D1Database, path: string, init: RequestInit = {}) {
    return payRouter.fetch(new Request(`https://pay.example.com${path}`, init), createEnv(db));
}

/** 与 pay.ts 相同的待签串构造方式 */
function signParamsFor(params: Record<string, string>, timestamp: string) {
    return { ...params, timestamp };
}

describe('GET /refund/query 认证', () => {
    it('缺少 sign 与请求头密钥时拒绝（原实现可匿名枚举）', async () => {
        const db = createMockDb(createKeysStore());
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1`);
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('缺少验证参数');
    });

    it('URL 里的明文 key 不再被接受', async () => {
        const db = createMockDb(createKeysStore());
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1&key=${API_KEY}`);
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('缺少验证参数');
    });

    it('缺少时间戳时拒绝', async () => {
        const db = createMockDb(createKeysStore());
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1&sign=${'a'.repeat(64)}`);
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('时间戳');
    });

    it('时间戳过期时拒绝（防重放）', async () => {
        const db = createMockDb(createKeysStore());
        const stale = String(Date.now() - 600_000);
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1&timestamp=${stale}&sign=${'a'.repeat(64)}`);
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
        expect(String(data.msg)).toContain('过期');
    });

    it('签名错误时拒绝', async () => {
        const db = createMockDb(createKeysStore());
        const timestamp = String(Date.now());
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1&timestamp=${timestamp}&sign=${'b'.repeat(64)}`);
        const data = await res.json() as any;
        expect(data.code).toBe(-2);
        expect(String(data.msg)).toContain('签名验证失败');
    });

    it('有效签名通过认证（继续查库，记录不存在返回 -4）', async () => {
        const store = createKeysStore();
        const db = createMockDb(store);
        const timestamp = String(Date.now());
        const sign = await generateSignAsync(
            signParamsFor({ pid: MERCHANT_ID, refund_no: 'R1' }, timestamp),
            API_KEY,
            'hmac-sha256'
        );
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1&timestamp=${timestamp}&sign=${sign}`);
        const data = await res.json() as any;
        expect(data.code).toBe(-4);
        expect(String(data.msg)).toContain('退款记录不存在');
    });

    it('有效签名可读到退款记录', async () => {
        const store = createKeysStore();
        const db = createMockDb(store, {
            refund: { refund_no: 'R1', out_trade_no: 'O1', order_id: 'T1', amount: 7.77, status: 1, created_at: 'x', completed_at: null },
        });
        const timestamp = String(Date.now());
        const sign = await generateSignAsync(
            signParamsFor({ pid: MERCHANT_ID, refund_no: 'R1' }, timestamp),
            API_KEY,
            'hmac-sha256'
        );
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1&timestamp=${timestamp}&sign=${sign}`);
        const data = await res.json() as any;
        expect(data.code).toBe(0);
        expect(data.refund_no).toBe('R1');
        expect(data.money).toBe(7.77);
    });

    it('请求头密钥可代替签名', async () => {
        const store = createKeysStore();
        const db = createMockDb(store);
        const res = await callWithDb(db, `/refund/query?pid=${MERCHANT_ID}&refund_no=R1`, {
            headers: { 'X-API-Key': API_KEY },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-4);
    });
});

describe('GET /orders 明文密钥收紧', () => {
    it('URL 里的明文 key 被拒绝', async () => {
        const db = createMockDb(createKeysStore());
        const res = await callWithDb(db, `/orders?pid=${MERCHANT_ID}&key=${API_KEY}`);
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('缺少验证参数');
    });

    it('请求头密钥可用（返回空列表而非认证失败）', async () => {
        const db = createMockDb(createKeysStore());
        const res = await callWithDb(db, `/orders?pid=${MERCHANT_ID}`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(1);
        expect(data.count).toBe(0);
    });

    it('错误密钥被拒绝', async () => {
        const db = createMockDb(createKeysStore());
        const res = await callWithDb(db, `/orders?pid=${MERCHANT_ID}`, {
            headers: { 'X-API-Key': 'wrong-key' },
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-3);
    });

    it('有效签名通过认证', async () => {
        const db = createMockDb(createKeysStore());
        const timestamp = String(Date.now());
        const sign = await generateSignAsync(
            { limit: '10', offset: '0', pid: MERCHANT_ID, timestamp },
            API_KEY,
            'hmac-sha256'
        );
        const res = await callWithDb(db, `/orders?pid=${MERCHANT_ID}&limit=10&offset=0&timestamp=${timestamp}&sign=${sign}`);
        const data = await res.json() as any;
        expect(data.code).toBe(1);
    });
});

describe('readApiKeyFromHeaders 不读取 URL', () => {
    it('只认 Authorization / X-API-Key 请求头', () => {
        expect(readApiKeyFromHeaders(new Headers({ 'X-API-Key': 'k1' }))).toBe('k1');
        expect(readApiKeyFromHeaders(new Headers({ 'Authorization': 'Bearer k2' }))).toBe('k2');
        expect(readApiKeyFromHeaders(new Headers())).toBeNull();
    });
});

describe('密钥来源统一为 api_keys 表', () => {
    it('matchApiKey 只认 api_keys 中的启用密钥', async () => {
        const store = createKeysStore();
        const db = createMockDb(store);
        const ok = await matchApiKey(db, MERCHANT_ID, API_KEY);
        expect(ok?.api_key).toBe(API_KEY);
        const bad = await matchApiKey(db, MERCHANT_ID, 'nope');
        expect(bad).toBeNull();
    });

    it('重置密钥后，入站验签与出站签名自动一致', async () => {
        const store = createKeysStore();
        const db = createMockDb(store);

        // 重置前：出站签名用旧密钥，入站验签通过
        const before = await signOutboundPayload(db, MERCHANT_ID, { pid: MERCHANT_ID, money: '7.77' });
        expect(before).not.toBeNull();
        expect(before!.signingKey.apiKey).toBe(API_KEY);

        // 商户在面板重置密钥（只改 api_keys 表）
        store.reset(NEW_API_KEY);

        // 重置后：出站签名立即使用新密钥
        const after = await signOutboundPayload(db, MERCHANT_ID, { pid: MERCHANT_ID, money: '7.77' });
        expect(after!.signingKey.apiKey).toBe(NEW_API_KEY);

        // 入站验签用新密钥可以通过 —— 这正是原实现失败的地方
        const verified = await verifySignAsync({ pid: MERCHANT_ID, money: '7.77' }, NEW_API_KEY, after!.sign, 'hmac-sha256');
        expect(verified).toBe(true);

        // 旧密钥不再能验签出站通知
        const staleVerified = await verifySignAsync({ pid: MERCHANT_ID, money: '7.77' }, API_KEY, after!.sign, 'hmac-sha256');
        expect(staleVerified).toBe(false);

        // 主密钥记录同步切换
        const primary = await resolveMerchantSigningKey(db, MERCHANT_ID);
        expect(primary?.apiKey).toBe(NEW_API_KEY);
    });

    it('商户无启用密钥时出站签名 fail-closed（返回 null，不静默用空密钥签名）', async () => {
        const db = createMockDb(createKeysStore());
        const result = await signOutboundPayload(db, OTHER_MERCHANT_ID, { pid: OTHER_MERCHANT_ID });
        expect(result).toBeNull();
    });
});

describe('退款申请 /refund 认证', () => {
    it('缺少验证参数时拒绝', async () => {
        const db = createMockDb(createKeysStore());
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: 'T1', money: '7.77' });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('缺少验证参数');
    });

    it('URL query 中的明文 key 不再参与退款认证', async () => {
        const db = createMockDb(createKeysStore());
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: 'T1', money: '7.77' });
        const res = await callWithDb(db, `/refund?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-1);
        expect(String(data.msg)).toContain('缺少验证参数');
    });

    it('POST body 中的明文 key 仍可用（订单不存在返回 -4）', async () => {
        const db = createMockDb(createKeysStore());
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: 'T1', money: '7.77', key: API_KEY });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-4);
    });

    it('签名正确时通过认证（订单不存在返回 -4）', async () => {
        const db = createMockDb(createKeysStore());
        const sign = await generateSignAsync(
            { pid: MERCHANT_ID, trade_no: 'T1', money: '7.77' },
            API_KEY,
            'hmac-sha256'
        );
        const body = new URLSearchParams({ pid: MERCHANT_ID, trade_no: 'T1', money: '7.77', sign });
        const res = await callWithDb(db, '/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const data = await res.json() as any;
        expect(data.code).toBe(-4);
    });
});
