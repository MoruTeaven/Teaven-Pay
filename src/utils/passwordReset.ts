/**
 * 密码找回令牌工具
 *
 * 设计要点：
 *  1. 令牌本体只在邮件链接里出现，数据库只存 HMAC-SHA256 摘要（见 migrations/0006_password_resets.sql），
 *     数据库被拖库也无法直接换取可用重置链接；
 *  2. 摘要密钥复用 JWT_SECRET（由调用方通过 resolveJwtSecret 取得，缺失即 fail-fast），不引入新的部署必填项；
 *  3. 令牌为 32 字节密码学随机数的 base64url 编码（43 字符），不可枚举；
 *  4. 提供令牌形态校验，供路由在任何数据库查询前做快速拒绝，减少无意义 IO。
 */

/** 令牌原始随机字节数（32 字节 → 43 字符 base64url） */
export const RESET_TOKEN_BYTES = 32;
/** 令牌有效期（毫秒）：30 分钟 */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
/** 单个令牌允许的最大校验失败次数 */
export const RESET_TOKEN_MAX_ATTEMPTS = 7;

/** 生成 base64url 编码的密码找回令牌 */
export function generateResetToken(bytes: number = RESET_TOKEN_BYTES): string {
    const raw = new Uint8Array(bytes);
    crypto.getRandomValues(raw);
    let binary = '';
    for (let i = 0; i < raw.length; i++) {
        binary += String.fromCharCode(raw[i]);
    }
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 校验令牌形态：base64url 字符集且长度合理（快速拒绝明显伪造的输入） */
export function isValidResetTokenShape(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    // 32 字节 → 43 字符；放宽到 32~64 以兼容后续长度调整
    if (token.length < 32 || token.length > 64) return false;
    return /^[A-Za-z0-9_-]+$/.test(token);
}

/** 计算令牌摘要 HMAC-SHA256(secret, token)，返回十六进制字符串 */
export async function hashResetToken(token: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
    return Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
