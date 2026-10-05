import { describe, expect, it } from 'vitest';
import { extractTimestamp, generateUUIDv7, isValidUUIDv7 } from './uuid';

// 任务 t-mumiipbs-58kkut 防回归：曾生成 8 段非标准 id
const LEGACY_8_SEGMENT_ID = '01a0ec96-d799-08c3-88d7-18fa-8ded-1c8e-4899';

describe('generateUUIDv7', () => {
    it('输出标准 8-4-4-4-12 五段格式', () => {
        for (let i = 0; i < 7; i++) {
            expect(generateUUIDv7()).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
            );
        }
    });

    it('通过 isValidUUIDv7 校验（含时间戳可提取）', () => {
        const before = Date.now();
        const id = generateUUIDv7();
        expect(isValidUUIDv7(id)).toBe(true);

        const ts = extractTimestamp(id);
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(Date.now());
    });

    it('旧的 8 段非标准 id 不再被判定为合法', () => {
        expect(isValidUUIDv7(LEGACY_8_SEGMENT_ID)).toBe(false);
        expect(() => extractTimestamp(LEGACY_8_SEGMENT_ID)).toThrow('Invalid UUID v7');
    });
});
