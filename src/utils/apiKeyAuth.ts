/**
 * 商户 API 密钥统一来源
 *
 * 安全整改背景（任务 t-mukt085p）：
 *   1) 入站验签曾同时存在两套来源——\`api_keys\` 表与 \`users.api_key\` 旧字段；
 *   2) 明文密钥可通过 URL query（\`key=\`）传递，会进访问日志 / CDN 日志 / Referer；
 *   3) 出站商户通知用 \`users.api_key\` 签名，而入站验签用 \`api_keys\` 表，
 *      商户在面板重置密钥后两者不一致，导致通知验签失败。
 *
 * 本模块把「商户密钥」收敛为唯一来源：\`api_keys\` 表中 status = 1 的记录。
 *   - 入站：只认 sign 签名，或 POST body / Authorization / X-API-Key 头里的明文密钥；
 *     URL query 中的 \`key\` 一律拒绝（\`readApiKeyFromHeaders\` 不读 query）。
 *   - 出站：主密钥（启用记录中创建时间最早的一条）签名，与入站验签同源。
 *   - 比较：一律常数时间，且遍历全部启用密钥，不做 \`===\` 短路比较。
 */

import { timingSafeEqual } from './constantTime';
import { generateSignAsync, resolveServerSignType, verifySignAsync } from './crypto';
import { isTimestampFresh } from './cashierAuth';

/** 商户启用中的 API 密钥记录（仅取验签/签名需要的列） */
export interface MerchantApiKeyRecord {
    id: string;
    user_id: string;
    api_key: string;
    name?: string | null;
    api_key_type: string | null;
    rsa_public_key?: string | null;
}

const API_KEY_COLUMNS = 'id, user_id, api_key, name, api_key_type, rsa_public_key';

/**
 * 读取商户全部启用密钥，按创建时间升序（首条即主密钥）。
 *
 * 同一商户可配置多把密钥，入站验签对全部启用密钥逐一比对；
 * 出站签名与收银台票据统一取主密钥，保证重置后两侧同源。
 */
export async function listActiveApiKeys(db: D1Database, userId: string): Promise<MerchantApiKeyRecord[]> {
    const result = await db.prepare(
        `SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE user_id = ? AND status = 1 ORDER BY created_at ASC, id ASC`
    ).bind(userId).all<MerchantApiKeyRecord>();

    return (result.results || []).filter(
        (row): row is MerchantApiKeyRecord => Boolean(row && typeof row.api_key === 'string' && row.api_key !== '')
    );
}

/** 主密钥：启用记录中创建时间最早的一条（与收银台票据签发口径一致） */
export async function getPrimaryApiKey(db: D1Database, userId: string): Promise<MerchantApiKeyRecord | null> {
    const records = await listActiveApiKeys(db, userId);
    return records.length > 0 ? records[0] : null;
}

/**
 * 从请求头读取明文密钥。
 *
 * 只接受 \`Authorization: Bearer <key>\` 与 \`X-API-Key\`，
 * 刻意不读 URL query，避免密钥进入日志 / 浏览器历史 / Referer。
 */
export function readApiKeyFromHeaders(headers: Headers): string | null {
    const authorization = headers.get('Authorization');
    if (authorization) {
        const matched = /^Bearer\s+(.+)$/i.exec(authorization.trim());
        const bearer = matched ? matched[1].trim() : '';
        if (bearer) return bearer;
    }

    const headerKey = (headers.get('X-API-Key') || '').trim();
    return headerKey || null;
}

/** 在商户启用密钥集合中常数时间匹配明文密钥 */
export async function matchApiKey(
    db: D1Database,
    userId: string,
    presented: string | null | undefined
): Promise<MerchantApiKeyRecord | null> {
    if (!presented) return null;

    const records = await listActiveApiKeys(db, userId);
    let matched: MerchantApiKeyRecord | null = null;

    // 不做命中即返回：避免用响应耗时区分「命中第几把密钥」
    for (const record of records) {
        if (timingSafeEqual(record.api_key, presented)) {
            matched = record;
        }
    }

    return matched;
}

export interface SignedRequestAuth {
    ok: boolean;
    code?: number;
    msg?: string;
    record?: MerchantApiKeyRecord;
}

/** 商户存在且可用（未封禁） */
async function loadActiveMerchant(db: D1Database, pid: string): Promise<{ ok: boolean; code?: number; msg?: string }> {
    if (!pid) return { ok: false, code: -1, msg: '商户ID不能为空' };

    const merchant = await db.prepare(
        'SELECT id, status FROM users WHERE id = ? AND role = ?'
    ).bind(pid, 'merchant').first<{ id: string; status: number }>();

    if (!merchant) return { ok: false, code: -3, msg: '商户不存在' };
    if (merchant.status !== 1) return { ok: false, code: -2, msg: '商户已被封禁' };

    return { ok: true };
}

/**
 * 已签名请求统一认证（pid + sign + 时间戳）。
 *
 * 待签串与 \`verifySignAsync\` 一致：\`pid\`、业务参数、\`timestamp\` 按字段名排序后拼接，
 * 空值不参与。密钥来源只有 \`api_keys\` 表，URL 中携带的 \`key\` 由调用方先行拒绝。
 */
export async function authorizeSignedRequest(
    db: D1Database,
    input: {
        pid: string;
        sign?: string | null;
        timestamp?: string | null;
        params?: Record<string, string | undefined>;
        requireTimestamp?: boolean;
    }
): Promise<SignedRequestAuth> {
    const { pid, sign, timestamp, params = {}, requireTimestamp = true } = input;

    if (!pid) return { ok: false, code: -1, msg: '商户ID不能为空' };
    if (!sign) return { ok: false, code: -1, msg: '缺少签名参数 sign，密钥不再通过 URL 传递' };
    if (requireTimestamp) {
        if (!timestamp) return { ok: false, code: -1, msg: '时间戳不能为空' };
        if (!isTimestampFresh(timestamp)) return { ok: false, code: -2, msg: '请求已过期，请检查时间戳' };
    }

    const merchant = await loadActiveMerchant(db, pid);
    if (!merchant.ok) return { ok: false, code: merchant.code, msg: merchant.msg };

    const records = await listActiveApiKeys(db, pid);
    if (records.length === 0) return { ok: false, code: -3, msg: '商户未配置 API 密钥' };

    const signParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' && value !== '') signParams[key] = value;
    }
    signParams.pid = pid;
    if (timestamp) signParams.timestamp = timestamp;

    let matched: MerchantApiKeyRecord | null = null;
    for (const record of records) {
        const signType = resolveServerSignType(record);
        if (await verifySignAsync(signParams, record.api_key, sign, signType)) {
            matched = record;
        }
    }

    if (!matched) return { ok: false, code: -2, msg: '签名验证失败' };
    return { ok: true, record: matched };
}

/**
 * 明文密钥或签名二选一的认证（POST body 场景）。
 *
 * 明文密钥只接受 POST body 与请求头，不接受 URL query；
 * 签名走与 GET 相同的 \`verifySignAsync\` 机制（此处不强制时间戳，保持存量调用兼容）。
 */
export async function authorizeKeyOrSign(
    db: D1Database,
    input: {
        pid: string;
        key?: string | null;
        sign?: string | null;
        params?: Record<string, string | undefined>;
    }
): Promise<SignedRequestAuth> {
    const { pid, key, sign, params = {} } = input;

    if (!pid) return { ok: false, code: -1, msg: '商户ID不能为空' };
    if (!sign && !key) return { ok: false, code: -1, msg: '缺少验证参数' };

    const merchant = await loadActiveMerchant(db, pid);
    if (!merchant.ok) return { ok: false, code: merchant.code, msg: merchant.msg };

    if (sign) {
        const records = await listActiveApiKeys(db, pid);
        if (records.length === 0) return { ok: false, code: -3, msg: '商户未配置 API 密钥' };

        const signParams: Record<string, string> = {};
        for (const [paramKey, value] of Object.entries(params)) {
            if (typeof value === 'string' && value !== '') signParams[paramKey] = value;
        }
        signParams.pid = pid;

        let matched: MerchantApiKeyRecord | null = null;
        for (const record of records) {
            const signType = resolveServerSignType(record);
            if (await verifySignAsync(signParams, record.api_key, sign, signType)) {
                matched = record;
            }
        }

        if (!matched) return { ok: false, code: -2, msg: '签名验证失败' };
        return { ok: true, record: matched };
    }

    const matched = await matchApiKey(db, pid, key);
    if (!matched) return { ok: false, code: -3, msg: '密钥错误' };
    return { ok: true, record: matched };
}

export interface MerchantSigningKey {
    keyId: string;
    apiKey: string;
    signType: string;
    signTypeLabel: string;
}

/**
 * 出站签名用密钥（商户通知等）。
 *
 * 与入站验签同源：都取 \`api_keys\` 表 status = 1 的主密钥，
 * 因此面板重置密钥后入站验签与出站通知签名会自动保持一致。
 */
export async function resolveMerchantSigningKey(db: D1Database, userId: string): Promise<MerchantSigningKey | null> {
    const record = await getPrimaryApiKey(db, userId);
    if (!record) return null;

    const signType = resolveServerSignType(record);
    return {
        keyId: record.id,
        apiKey: record.api_key,
        signType,
        signTypeLabel: signType === 'md5' ? 'MD5' : 'HMAC-SHA256',
    };
}

/** 生成出站签名；商户无可用密钥时返回 null，调用方须 fail-closed 处理 */
export async function signOutboundPayload(
    db: D1Database,
    userId: string,
    params: Record<string, unknown>
): Promise<{ signingKey: MerchantSigningKey; sign: string } | null> {
    const signingKey = await resolveMerchantSigningKey(db, userId);
    if (!signingKey) return null;

    const sign = await generateSignAsync(params, signingKey.apiKey, signingKey.signType);
    return { signingKey, sign };
}
