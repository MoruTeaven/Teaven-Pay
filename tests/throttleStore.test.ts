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

describe('getActiveBackend 语义：报「实际生效」而非「配置首选」', () => {
    it('未执行任何操作时为 null，而不是把首选后端当成事实', () => {
        const store = createThrottleStore({ CACHE: createFakeKv(createFakeKvState()), DB: createFakeD1(createFakeD1State()) });
        // 关键：此时并未真的用过任何后端，不应报 kv
        expect(store.getActiveBackend()).toBeNull();
    });

    it('首次成功后才填成事实值', async () => {
        const store = createThrottleStore({ DB: createFakeD1(createFakeD1State()) });
        expect(store.getActiveBackend()).toBeNull();

        await store.read('k');
        expect(store.getActiveBackend()).toBe('d1');
    });

    it('首选后端失败并降级后，报的是真正成功的那个', async () => {
        const d1State = createFakeD1State();
        d1State.tableMissing = true;
        // 只有 D1 和内存，D1 表缺失 → 应报 memory
        const store = createThrottleStore({ DB: createFakeD1(d1State) });
        await store.increment('k', 60);

        expect(store.getActiveBackend()).toBe('memory');
    });

    it('KV 可用并成功时如实报 kv', async () => {
        const store = createThrottleStore({ CACHE: createFakeKv(createFakeKvState()) });
        await store.increment('k', 60);

        expect(store.getActiveBackend()).toBe('kv');
    });
});
