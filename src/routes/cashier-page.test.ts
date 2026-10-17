import { describe, expect, it } from 'vitest';
import worker from '../index';
import { Env } from '../types/env';

/**
 * 收银台结果页回归测试
 *
 * 两件事必须锁死：
 *  1) 支付成功后能自动跳回商户 return_url（虎皮椒渠道成功页不会自己跳回来）；
 *  2) 页面里内插的 name / return_url 必须转义，且 return_url 只允许 http(s)。
 */
function createEnv(order: Record<string, unknown> | null): Env {
    const prepare = (sql: string) => ({
        bind: () => ({
            first: async () => order,
            all: async () => {
                // 订单票据签发需要商户主密钥（api_keys 表）
                if (sql.includes('FROM api_keys')) {
                    return { results: [{ id: 'key-1', user_id: 'u-1', api_key: 'cashier-page-test-key', api_key_type: 'hmac-sha256', rsa_public_key: null }] };
                }
                return { results: [] };
            },
            run: async () => ({ success: true }),
        }),
        first: async () => order,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
    });
    return { DB: { prepare } as unknown as D1Database } as unknown as Env;
}

async function renderCashier(order: Record<string, unknown> | null) {
    const res = await worker.fetch(
        new Request('https://pay.example.com/cashier/T777777'),
        createEnv(order),
        {} as ExecutionContext
    );
    return await res.text();
}

const BASE_ORDER = {
    id: 'T777777',
    amount: 7.77,
    name: '测试商品',
    payment_type: 'pt_wxpay',
    type_name: '微信支付',
    return_url: 'https://merchant.example.com/return',
};

describe('收银台 /cashier/:tradeNo', () => {
    it('注入 return_url 并带自动返回脚本', async () => {
        const html = await renderCashier(BASE_ORDER);
        expect(html).toContain("var returnUrl = 'https:\\/\\/merchant.example.com\\/return'");
        expect(html).toContain('window.location.replace(returnUrl)');
        expect(html).toContain('秒后自动返回');
    });

    it('name 中的 HTML 被转义，不能注入脚本', async () => {
        const html = await renderCashier({
            ...BASE_ORDER,
            name: '<img src=x onerror=alert(1)>',
        });
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('return_url 非 http(s) 时被丢弃，不生成跳转', async () => {
        const html = await renderCashier({
            ...BASE_ORDER,
            return_url: 'javascript:alert(1)',
        });
        // 脚本里虽然始终带有跳转逻辑，但运行时 returnUrl 为空即不会跳转
        expect(html).toContain("var returnUrl = ''");
        expect(html).not.toContain('javascript:alert');
    });

    it('未配置 return_url 时不自动跳转', async () => {
        const html = await renderCashier({ ...BASE_ORDER, return_url: '' });
        expect(html).toContain("var returnUrl = ''");
        expect(html).not.toContain('merchant.example.com');
    });

    it('签发订单访问票据，轮询带上它（B-3：状态接口已需凭证）', async () => {
        const html = await renderCashier(BASE_ORDER);
        // 票据格式 v1.<tradeNo>.<expiresAt>.<hmacHex>
        expect(html).toMatch(/var orderToken = 'v1\.T777777\.\d+\.[0-9a-f]{64}'/);
        expect(html).toContain("url += '?token=' + encodeURIComponent(orderToken)");
    });

    it('票据签发失败时留空，页面不会降级为匿名可读', async () => {
        // 商户无启用密钥 → 签不出票据
        const prepare = () => ({
            bind: () => ({
                first: async () => BASE_ORDER,
                all: async () => ({ results: [] }),
                run: async () => ({ success: true }),
            }),
            first: async () => BASE_ORDER,
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
        });
        const env = { DB: { prepare } as unknown as D1Database } as unknown as Env;
        const res = await worker.fetch(new Request('https://pay.example.com/cashier/T777777'), env, {} as ExecutionContext);
        const html = await res.text();
        expect(html).toContain("var orderToken = ''");
    });
});
