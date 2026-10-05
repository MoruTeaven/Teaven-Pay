/**
 * throttleStore：KV → D1 → 内存 三级降级验证
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createThrottleStore } from '../src/utils/throttleStore';
import { createFakeD1, createFakeD1State, createFakeKv, createFakeKvState } from './helpers/fakeBindings';

describe('throttleStore 后端选择', () => {
    let kvState: ReturnType<typeof createFakeKvState>;
    let d1State: ReturnType<typeof createFakeD1State>;
    let env: any;

    beforeEach(() => {
        kvState = createFakeKvState();
        d1State = createFakeD1State();
        env = { CACHE: createFakeKv(kvState), DB: createFakeD1(d1State) };
    });

    it('KV 可用时优先使用 KV', async () => {
        const store = createThrottleStore(env);
        const first = await store.increment('rate_limit:login:1.2.3.4', 60);
        const second = await store.increment('rate_limit:login:1.2.3.4', 60);

        expect(store.getActiveBackend()).toBe('kv');
        expect(first.count).toBe(1);
        expect(second.count).toBe(2);
        expect(second.resetAt).toBe(first.resetAt);
        // 计数确实写进了 KV，且 TTL 合法（>=60s）
        expect(JSON.parse(kvState.values.get('rate_limit:login:1.2.3.4')!)).toEqual({
            count: 2,
            resetAt: second.resetAt,
        });
    });

    it('KV 未绑定时使用 D1 计数表', async () => {
        const store = createThrottleStore({ DB: env.DB });
        await store.increment('k', 60);
        const second = await store.increment('k', 60);

        expect(store.getActiveBackend()).toBe('d1');
        expect(second.count).toBe(2);
        expect(d1State.rows.get('k')).toMatchObject({ count: 2 });
    });

    it('KV 读写报错时降级到 D1，不再反复打 KV', async () => {
        const store = createThrottleStore(env);
        kvState.failNext = true; // 首次 put 抛错

        const second = await store.increment('k', 60);

        expect(store.getActiveBackend()).toBe('d1');
        expect(second.count).toBeGreaterThan(0);
        expect(d1State.rows.get('k')).toBeDefined();
    });

    it('D1 计数表不存在时继续降级到内存兜底', async () => {
        d1State.tableMissing = true;
        const store = createThrottleStore({ DB: env.DB });

        const first = await store.increment('k', 60);
        const second = await store.increment('k', 60);

        expect(store.getActiveBackend()).toBe('memory');
        expect(first.count).toBe(1);
        expect(second.count).toBe(2);
    });

    it('KV / D1 都没有绑定时内存兜底仍然计数', async () => {
        const store = createThrottleStore({});
        const states = [];
        for (let i = 0; i < 7; i++) {
            states.push(await store.increment('login_fail:admin:acct:root', 60));
        }

        expect(store.getActiveBackend()).toBe('memory');
        expect(states.map(s => s.count)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(states[6].resetAt).toBeGreaterThan(Date.now());

        await store.remove('login_fail:admin:acct:root');
        expect(await store.read('login_fail:admin:acct:root')).toBeNull();
    });

    it('窗口过期后重新计数', async () => {
        const store = createThrottleStore({});
        const first = await store.increment('k', 60);
        // 直接把窗口推到过去，模拟时间流逝
        await store.remove('k');
        const expired = await store.read('k');
        expect(expired).toBeNull();

        const next = await store.increment('k', 60);
        expect(next.count).toBe(1);
        expect(next.resetAt).toBeGreaterThan(first.resetAt - 1000);
    });
});
