import { describe, expect, it } from 'vitest';
import {
    generateResetToken,
    hashResetToken,
    isValidResetTokenShape,
    RESET_TOKEN_BYTES,
    RESET_TOKEN_MAX_ATTEMPTS,
    RESET_TOKEN_TTL_MS,
} from './passwordReset';

/** 任务 t-mv0w9c3h-wx1xft：商户密码找回令牌 */
describe('generateResetToken', () => {
    it('生成 base64url 形态且长度符合预期', () => {
        const token = generateResetToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).toHaveLength(43); // 32 字节 → 43 字符（无填充）
    });

    it('每次生成都不同（密码学随机）', () => {
        const set = new Set(Array.from({ length: 200 }, () => generateResetToken()));
        expect(set.size).toBe(200);
    });

    it('可指定字节数', () => {
        expect(generateResetToken(16)).toHaveLength(22);
        expect(generateResetToken(8)).toHaveLength(11);
    });
});

describe('isValidResetTokenShape', () => {
    it('接受合法令牌', () => {
        expect(isValidResetTokenShape(generateResetToken())).toBe(true);
    });

    it('拒绝过短 / 过长 / 非 base64url 字符', () => {
        expect(isValidResetTokenShape('short')).toBe(false);
        expect(isValidResetTokenShape('a'.repeat(31))).toBe(false);
        expect(isValidResetTokenShape('a'.repeat(65))).toBe(false);
        expect(isValidResetTokenShape('a'.repeat(32) + '!')).toBe(false);
        expect(isValidResetTokenShape('a'.repeat(32) + '=')).toBe(false);
    });

    it('拒绝非字符串输入', () => {
        expect(isValidResetTokenShape(undefined)).toBe(false);
        expect(isValidResetTokenShape(null)).toBe(false);
        expect(isValidResetTokenShape(123)).toBe(false);
        expect(isValidResetTokenShape({})).toBe(false);
    });
});

describe('hashResetToken', () => {
    it('同令牌同密钥摘要稳定，且为 64 位十六进制', async () => {
        const token = generateResetToken();
        const a = await hashResetToken(token, 'secret-77777');
        const b = await hashResetToken(token, 'secret-77777');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('不同密钥产生不同摘要（换密钥即全部令牌失效）', async () => {
        const token = generateResetToken();
        const a = await hashResetToken(token, 'secret-a');
        const b = await hashResetToken(token, 'secret-b');
        expect(a).not.toBe(b);
    });

    it('不同令牌产生不同摘要', async () => {
        const a = await hashResetToken(generateResetToken(), 'secret');
        const b = await hashResetToken(generateResetToken(), 'secret');
        expect(a).not.toBe(b);
    });

    it('摘要不可逆：不等于原文本身', async () => {
        const token = generateResetToken();
        const hash = await hashResetToken(token, 'secret');
        expect(hash).not.toBe(token);
        expect(hash.includes(token)).toBe(false);
    });
});

describe('常量约束', () => {
    it('令牌有效期 30 分钟、最大尝试次数为 7', () => {
        expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
        expect(RESET_TOKEN_MAX_ATTEMPTS).toBe(7);
        expect(RESET_TOKEN_BYTES).toBe(32);
    });
});
