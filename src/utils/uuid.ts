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
    
    // 生成随机数部分
    const randomBytes = new Uint8Array(10);
    crypto.getRandomValues(randomBytes);
    
    // 构建 UUID 各部分
    // 时间戳高位 (32 位)
    const timeHigh = Number((timestamp >> 16n) & 0xFFFFFFFFn);
    // 时间戳低位 (16 位) + 版本号 (4 位) + 亚毫秒 (12 位)
    const timeLowVersion = Number(((timestamp & 0xFFFFn) << 12n) | (7n << 8n) | BigInt(randomBytes[0] & 0xFF));
    // 变体 (2 位) + 随机数 (6 位) + 随机数 (8 位)
    const variantRandom = Number((BigInt(0b10) << 14n) | (BigInt(randomBytes[1] & 0x3F) << 8n) | BigInt(randomBytes[2]));
    // 随机数 (8 位) + 随机数 (8 位)
    const random1 = Number((randomBytes[3] << 8) | randomBytes[4]);
    // 随机数 (8 位) + 随机数 (8 位)
    const random2 = Number((randomBytes[5] << 8) | randomBytes[6]);
    // 随机数 (8 位) + 随机数 (8 位)
    const random3 = Number((randomBytes[7] << 8) | randomBytes[8]);
    // 随机数 (8 位) + 随机数 (8 位)
    const random4 = Number((randomBytes[9] << 8) | randomBytes[0]);
    
    // 格式化为 UUID 字符串
    const hex = (num: number, length: number) => num.toString(16).padStart(length, '0');
    
    return [
        hex(timeHigh, 8),
        hex(timeLowVersion & 0xFFFF, 4),
        hex((timeLowVersion >> 16) & 0xFFFF, 4),
        hex(variantRandom, 4),
        hex(random1, 4),
        hex(random2, 4),
        hex(random3, 4),
        hex(random4, 4),
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
    const timeHigh = parseInt(parts[0], 16);
    const timeLow = parseInt(parts[1], 16);
    
    return (timeHigh << 16) | timeLow;
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
