/**
 * JWT 签名密钥：签发与验证的唯一来源
 *
 * 背景：签发侧曾回退到内置默认密钥、验证侧回退到空串，两侧不一致 ——
 * 未配置 JWT_SECRET 时签出的 token 一律 401（配置静默失效），
 * 且「默认密钥」字样还会诱导运维直接沿用弱值。
 *
 * 约定：JWT_SECRET 必填。签发与校验一律走 resolveJwtSecret()，
 * 缺失/纯空白即抛错（fail-fast），不存在任何兜底密钥。
 */

import { Env } from '../types/env';

/** 缺失时的修复指引（同时用于错误日志与 500 响应文案） */
export const JWT_SECRET_MISSING_MSG =
    '服务端未配置 JWT_SECRET，无法签发/校验登录凭证。' +
    '生产环境执行 npx wrangler secret put JWT_SECRET，本地开发写入 .dev.vars（见 .dev.vars.example）。' +
    '该变量为必填项，缺失时不做任何默认密钥回退。';

/** JWT_SECRET 缺失（配置错误，而非凭据错误） */
export class JwtSecretMissingError extends Error {
    constructor() {
        super('JWT_SECRET 未配置');
        this.name = 'JwtSecretMissingError';
    }
}

export function isJwtSecretMissingError(error: unknown): boolean {
    return error instanceof JwtSecretMissingError || (error as { name?: string } | null)?.name === 'JwtSecretMissingError';
}

/**
 * 解析 JWT 签名密钥（签发与验证的唯一读取入口，无 fallback）
 * @throws {JwtSecretMissingError} 未配置或仅空白时抛出
 */
export function resolveJwtSecret(env: Env | undefined): string {
    const raw = typeof env?.JWT_SECRET === 'string' ? env.JWT_SECRET : '';
    const secret = raw.trim();
    if (!secret) throw new JwtSecretMissingError();
    return secret;
}

/** 是否已配置（仅用于健康检查/诊断展示，鉴权路径请用 resolveJwtSecret） */
export function isJwtSecretConfigured(env: Env | undefined): boolean {
    return typeof env?.JWT_SECRET === 'string' && env.JWT_SECRET.trim().length > 0;
}
