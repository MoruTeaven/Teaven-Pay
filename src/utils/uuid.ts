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
    // 16 字节：48 位时间戳 + 4 位版本 + 12 位 rand_a + 2 位变体 + 62 位 rand_b
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // 前 6 字节写入毫秒级时间戳（大端序）
    let timestamp = BigInt(Date.now());
    for (let i = 5; i >= 0; i--) {
        bytes[i] = Number(timestamp & 0xFFn);
        timestamp >>= 8n;
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x70; // 版本 7 (0111)
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // 变体 10xx

    // 标准 8-4-4-4-12 五段格式
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
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
    
    // 前 12 位十六进制即 48 位时间戳（<< 会按 32 位截断，故用 parseInt 直接解析）
    const parts = uuid.split('-');
    return parseInt(parts[0] + parts[1], 16);
}

/**
 * 生成简单的唯一 ID (用于订单号等)
 * 格式: UUID v7
 */
export function generateTradeNo(): string {
    return generateUUIDv7();
}

/**
 * 生成退款单号
 * 格式: REF_<UUID v7>
 *
 * 说明: 退款单号会作为退款查询与对账的凭据对外暴露，
 * 原实现使用 Math.random 生成 5 位随机数，可被枚举预测；
 * 改为 UUID v7（时间戳 + 密码学随机）保证不可预测且可排序。
 */
export function generateRefundNo(): string {
    return `REF_${generateUUIDv7()}`;
}
