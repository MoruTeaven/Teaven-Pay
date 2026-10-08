/**
 * JWT_SECRET 必填守卫
 *
 * 管理后台与商户中心的所有接口，要么签发 JWT（登录），要么校验 JWT（鉴权），
 * 因此这两组路由在密钥缺失时统一 fail-fast（500），而不是放行后逐个 401。
 * 支付类接口（/api/pay、/submit.php、/api.php）走商户 API Key 签名，不受影响。
 */

import { MiddlewareHandler } from 'hono';
import { Env } from '../types/env';
import { isJwtSecretConfigured, JWT_SECRET_MISSING_MSG } from '../utils/jwtSecret';

export const jwtSecretGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    if (!isJwtSecretConfigured(c.env)) {
        console.error('[FATAL] JWT_SECRET 未配置，拒绝处理后台/商户接口:', c.req.path);
        return c.json({ code: -5, msg: JWT_SECRET_MISSING_MSG }, 500);
    }
    await next();
};
