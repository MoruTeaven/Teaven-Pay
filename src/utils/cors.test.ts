import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins, resolveAllowedOrigin } from './cors';

/** 任务 t-mukt0879：CORS 收紧为白名单，未配置时不允许通配 */
describe('parseAllowedOrigins', () => {
    it('未配置/空串返回空数组', () => {
        expect(parseAllowedOrigins(undefined)).toEqual([]);
        expect(parseAllowedOrigins('')).toEqual([]);
        expect(parseAllowedOrigins('   ')).toEqual([]);
    });

    it('逗号分隔并去掉空白与结尾斜杠', () => {
        expect(parseAllowedOrigins('https://a.com, https://b.com/')).toEqual(['https://a.com', 'https://b.com']);
    });
});

describe('resolveAllowedOrigin', () => {
    it('未配置白名单时一律拒绝（不再回落通配）', () => {
        expect(resolveAllowedOrigin('https://evil.com', [])).toBe('');
        expect(resolveAllowedOrigin('https://any.com', parseAllowedOrigins(undefined))).toBe('');
    });

    it('无 Origin 头时返回空（同源请求不受影响）', () => {
        expect(resolveAllowedOrigin(undefined, ['https://a.com'])).toBe('');
    });

    it('命中白名单时回显该 Origin', () => {
        expect(resolveAllowedOrigin('https://a.com', ['https://a.com', 'https://b.com'])).toBe('https://a.com');
    });

    it('未命中白名单时拒绝', () => {
        expect(resolveAllowedOrigin('https://evil.com', ['https://a.com'])).toBe('');
    });

    it('仅显式配置通配时才允许通配', () => {
        expect(resolveAllowedOrigin('https://any.com', ['*'])).toBe('*');
    });

    it('支持子域通配', () => {
        const list = ['https://*.example.com'];
        expect(resolveAllowedOrigin('https://shop.example.com', list)).toBe('https://shop.example.com');
        expect(resolveAllowedOrigin('https://evil.example.com', list)).toBe('https://evil.example.com');
    });

    it('子域通配不匹配多级子域与后缀拼接', () => {
        const list = ['https://*.example.com'];
        expect(resolveAllowedOrigin('https://a.b.example.com', list)).toBe('');
        expect(resolveAllowedOrigin('https://example.com', list)).toBe('');
        expect(resolveAllowedOrigin('https://example.com.evil.com', list)).toBe('');
    });
});
