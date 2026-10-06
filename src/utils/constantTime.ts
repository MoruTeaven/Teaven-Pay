/**
 * 常数时间比较工具
 *
 * 用于密码哈希、签名、API Key 等敏感字符串的比较，避免通过
 * 响应耗时差异逐字节爆破（时序攻击）。
 */

/**
 * 常数时间字符串比较（逐字节异或累计，不做短路）
 *
 * 长度不同时也参与累计，使不等长输入耗时与等长输入处在同一量级；
 * 越界读取按 0 处理，不泄露哪一侧更长。
 */
export function timingSafeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const bufA = encoder.encode(a);
    const bufB = encoder.encode(b);

    const length = Math.max(bufA.length, bufB.length);
    let diff = bufA.length ^ bufB.length;

    for (let i = 0; i < length; i++) {
        // 越界读取得到 undefined，位运算会转为 0
        diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
    }

    return diff === 0;
}

/**
 * 常数时间签名比较
 *
 * 签名大小写不敏感（易支付生态里 MD5/HMAC 签名常以大写传输），
 * 归一化后比较。
 */
export function timingSafeEqualSign(a: string, b: string): boolean {
    return timingSafeEqual(normalizeSign(a), normalizeSign(b));
}

/** 签名归一化：去空白 + 转小写 */
function normalizeSign(value: string): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
