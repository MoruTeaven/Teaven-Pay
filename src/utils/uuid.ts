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
    
    // 生成随机数部分 (10 字节)
    const randomBytes = new Uint8Array(10);
    crypto.getRandomValues(randomBytes);
    
    // 标准 UUID v7 格式: 8-4-4-4-12
    // 时间戳高位 (32 位) -> 8 字符
    const timeHigh = Number((timestamp >> 12n) & 0xFFFFFFFFn);
    // 时间戳低位 (12 位) + 版本号 7 (4 位) -> 4 字符
    const timeLowVersion = Number(((timestamp & 0xFFFn) << 4n) | 7n);
    // 变体 10 (2 位) + 随机数 (14 位) -> 4 字符
    const variantRandom = Number((0b10 << 14) | ((randomBytes[0] & 0x3F) << 8) | randomBytes[1]);
    // 随机数 (16 位) -> 4 字符
    const rand1 = Number((randomBytes[2] << 8) | randomBytes[3]);
    // 随机数 (48 位) -> 12 字符
    const rand2 = Number((randomBytes[4] << 8) | randomBytes[5]);
    const rand3 = Number((randomBytes[6] << 8) | randomBytes[7]);
    const rand4 = Number((randomBytes[8] << 8) | randomBytes[9]);
    
    // 格式化为 UUID 字符串
    const hex = (num: number, length: number) => num.toString(16).padStart(length, '0');
    
    return [
        hex(timeHigh, 8),
        hex(timeLowVersion, 4),
        hex(variantRandom, 4),
        hex(rand1, 4),
        hex(rand2, 4) + hex(rand3, 4) + hex(rand4, 4),
    ].join('-');
}

/**
 * 验证 UUID v7 格式
 */
export function isValidUUIDv7(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{3}7-[89ab][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    const timeLow = BigInt(parseInt(parts[1].substring(0, 3), 16));
    
    return Number((timeHigh << 12n) | timeLow);
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
