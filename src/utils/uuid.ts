/**
 * UUID v7 生成器
 * 符合 RFC 9562 规范
 */

/**
 * 生成 UUID v7
 * 
 * UUID v7 格式:
 * - 48 位毫秒级时间戳
 * - 4 位版本号 (0111)
 * - 12 位亚毫秒级时间戳
 * - 2 位变体 (10)
 * - 62 位随机数
 * 
 * 示例: 018f14e0-7e8a-7xxx-xxxx-xxxxxxxxxxxx
 */
export function generateUUIDv7(): string {
    const now = Date.now();
    
    // 48 位毫秒级时间戳
    const timestamp = BigInt(now);
    
    // 生成随机数部分 (10 字节 = 80 位，随机需要 74 位，足够)
    const r = new Uint8Array(10);
    crypto.getRandomValues(r);
    
    // RFC 9562 UUID v7 布局:
    // 第一段 (8 字符) : unix_ts_ms[47:16] 高 32 位时间戳
    const timeHigh = Number((timestamp >> 16n) & 0xFFFFFFFFn);
    // 第二段 (4 字符) : unix_ts_ms[15:0] 低 16 位时间戳
    const timeMid = Number(timestamp & 0xFFFFn);
    // 第三段 (4 字符) : ver(4) + rand_a(12)
    const timeHiVersion = (7 << 12) | (r[0] << 4) | (r[1] >> 4);
    // 第四段 (4 字符) : var(2) + rand_b_high(14)
    const randBHigh = ((r[1] & 0x0F) << 10) | (r[2] << 2) | (r[3] >> 6);
    const clockSeq = (0b10 << 14) | randBHigh;
    // 第五段 (12 字符) : rand_b_low(48)
    const node = Number(
        (BigInt(r[3] & 0x3F) << 42n) |
        (BigInt(r[4]) << 34n) |
        (BigInt(r[5]) << 26n) |
        (BigInt(r[6]) << 18n) |
        (BigInt(r[7]) << 10n) |
        (BigInt(r[8]) << 2n) |
        (BigInt(r[9]) >> 6n)
    );
    
    const hex = (num: number, length: number) => num.toString(16).padStart(length, '0');
    
    return [
        hex(timeHigh, 8),
        hex(timeMid, 4),
        hex(timeHiVersion, 4),
        hex(clockSeq, 4),
        hex(node, 12),
    ].join('-');
}

/**
 * 验证 UUID v7 格式
 */
export function isValidUUIDv7(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

/**
 * 从 UUID v7 提取时间戳
 */
export function extractTimestamp(uuid: string): number {
    if (!isValidUUIDv7(uuid)) {
        throw new Error('Invalid UUID v7');
    }
    
    const parts = uuid.split('-');
    const timeHigh = BigInt(parseInt(parts[0], 16));
    const timeMid = BigInt(parseInt(parts[1], 16));
    
    return Number((timeHigh << 16n) | timeMid);
}

/**
 * 生成简单的唯一 ID (用于订单号等)
 * 格式: 时间戳 + 随机数
 */
export function generateTradeNo(): string {
    const now = Date.now();
    const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    return `${now}${random}`;
}

/**
 * 生成退款单号
 * 格式: REF_时间戳_随机数
 */
export function generateRefundNo(): string {
    const now = Date.now();
    const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    return `REF_${now}_${random}`;
}
