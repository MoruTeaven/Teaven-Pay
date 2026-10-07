/**
 * 加密工具函数
 * 注意: 本文件按线上运行行为 1:1 重建（源对象损坏恢复）
 */

import md5Lib from 'md5';

/**
 * 生成随机字符串
 */
export function generateNonce(length: number = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const random = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(random).map((b) => chars[b % chars.length]).join('');
}

/**
 * 生成 API Key（UUIDv7 无连字符）
 */
export async function generateApiKey(): Promise<string> {
    const { generateUUIDv7 } = await import('./uuid');
    return generateUUIDv7().replace(/-/g, '');
}

/**
 * HMAC-SHA256 签名
 */
export async function hmacSha256(key: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 哈希
 */
export async function sha256(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * RSA-SHA256 私钥签名
 */
export async function rsaSign(params: Record<string, any> | string, privateKey: string): Promise<string> {
    let signStr: string;
    if (typeof params === 'string') {
        signStr = params;
    } else {
        const sortedKeys = Object.keys(params).sort();
        const parts: string[] = [];
        for (const key of sortedKeys) {
            if (params[key] !== '' && params[key] !== undefined && key !== 'sign') {
                parts.push(`${key}=${params[key]}`);
            }
        }
        signStr = parts.join('&');
    }
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    const pemContents = privateKey.replace(pemHeader, '').replace(pemFooter, '').replace(/\s/g, '');
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        'pkcs8',
        binaryDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const encoder = new TextEncoder();
    const data = encoder.encode(signStr);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * RSA-SHA256 公钥验签
 */
export async function rsaVerify(params: Record<string, any> | string, signature: string, publicKey: string): Promise<boolean> {
    try {
        let signStr: string;
        if (typeof params === 'string') {
            signStr = params;
        } else {
            const sortedKeys = Object.keys(params).sort();
            const parts: string[] = [];
            for (const key of sortedKeys) {
                if (params[key] !== '' && params[key] !== undefined && key !== 'sign') {
                    parts.push(`${key}=${params[key]}`);
                }
            }
            signStr = parts.join('&');
        }
        const pemHeader = '-----BEGIN PUBLIC KEY-----';
        const pemFooter = '-----END PUBLIC KEY-----';
        const pemContents = publicKey.replace(pemHeader, '').replace(pemFooter, '').replace(/\s/g, '');
        const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
        const key = await crypto.subtle.importKey(
            'spki',
            binaryDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        const encoder = new TextEncoder();
        const data = encoder.encode(signStr);
        const signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, data);
    } catch (error) {
        console.error('RSA verify error:', error);
        return false;
    }
}

/**
 * X.509 证书 PEM → RSA 公钥 CryptoKey（微信 v3 平台证书 / 标准证书）
 * 通过手写 ASN.1 DER 遍历提取 SubjectPublicKeyInfo，避免引入额外依赖。
 */
export async function x509CertToPublicKey(certPem: string): Promise<CryptoKey> {
    const spki = parseX509(certPem).publicKey;
    return crypto.subtle.importKey(
        'spki',
        spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength) as ArrayBuffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        true,
        ['verify']
    );
}

/**
 * 证书有效期（毫秒时间戳），用于平台证书到期自动刷新
 */
export function x509CertValidity(certPem: string): { notBefore: number; notAfter: number } {
    const c = parseX509(certPem);
    return { notBefore: c.notBefore, notAfter: c.notAfter };
}

interface DerField { start: number; end: number; next: number; tagStart: number; }

function derRead(buf: Uint8Array, at: number): DerField & { tag: number } {
    const tag = buf[at];
    let p = at + 1;
    let len = buf[p++];
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
    }
    return { tag, start: p, end: p + len, next: p + len, tagStart: at };
}

/**
 * 遍历 X.509 证书 DER，取出 SubjectPublicKeyInfo 与有效期。
 * 结构：Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 */
function parseX509(certPem: string): { publicKey: Uint8Array; notBefore: number; notAfter: number } {
    const b64 = certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const cert = derRead(der, 0);
    if (cert.tag !== 0x30) throw new Error('X509: 证书结构无效');
    const tbs = derRead(der, cert.start);
    let p = tbs.start;
    const first = derRead(der, p);
    if (first.tag === 0xa0) p = first.next; // version
    p = derRead(der, p).next;               // serialNumber
    p = derRead(der, p).next;               // signature
    p = derRead(der, p).next;               // issuer
    const validity = derRead(der, p);       // validity
    const nb = derRead(der, validity.start);
    const na = derRead(der, nb.next);
    const notBefore = asn1TimeToMs(der.subarray(nb.start, nb.end));
    const notAfter = asn1TimeToMs(der.subarray(na.start, na.end));
    p = validity.next;
    p = derRead(der, p).next;               // subject
    const spki = derRead(der, p);           // subjectPublicKeyInfo（需含 SEQUENCE 头，否则 importKey 失败）
    return { publicKey: der.subarray(spki.tagStart, spki.next), notBefore, notAfter };
}

/** ASN.1 UTCTime/GeneralizedTime → 毫秒时间戳 */
function asn1TimeToMs(raw: Uint8Array): number {
    const s = new TextDecoder().decode(raw);
    if (s.length === 13 && s.endsWith('Z')) {
        // RFC 5280: YY >= 50 视为 19xx，否则 20xx
        let yy = parseInt(s.slice(0, 2), 10);
        yy = yy >= 50 ? 1900 + yy : 2000 + yy;
        return Date.parse(`${yy}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}Z`);
    }
    return Date.parse(s.slice(0, -1) + 'Z');
}

/**
 * 构造待签名字符串（剔除空值/sign/sign_type，按 key 排序）
 */
function buildSignString(params: Record<string, any>): string {
    const sortedKeys = Object.keys(params).sort();
    const parts: string[] = [];
    for (const key of sortedKeys) {
        if (params[key] !== '' && params[key] !== undefined && key !== 'sign' && key !== 'sign_type') {
            parts.push(key + '=' + params[key]);
        }
    }
    return parts.join('&');
}

/**
 * 签名类型归一化（sha256/hmacsha256/hmac-sha256 → hmac-sha256；下划线 → 连字符）
 */
function normalizeSignType(signType: string = 'md5'): string {
    const normalized = signType.toLowerCase().replace(/_/g, '-');
    if (normalized === 'sha256' || normalized === 'hmacsha256' || normalized === 'hmac-sha256') {
        return 'hmac-sha256';
    }
    return normalized;
}

/**
 * 服务端权威签名类型（安全整改：sign_type 不再接受客户端覆盖）
 *
 * 只认商户密钥记录里的 api_key_type，未配置时按 hmac-sha256 处理。
 * 客户端传来的 sign_type 一律忽略——否则攻击者可把 hmac-sha256 降级成
 * md5，造成签名校验绕过。
 */
export function resolveServerSignType(record?: { api_key_type?: string | null } | null): string {
    const configured = (record?.api_key_type ?? '').trim();
    return configured ? normalizeSignType(configured) : 'hmac-sha256';
}

/**
 * 生成 MD5 兼容签名
 */
export function generateSign(params: Record<string, any>, apiKey: string): string {
    const signStr = apiKey + buildSignString(params) + apiKey;
    return md5Lib(signStr);
}

/**
 * 生成签名（支持 md5 / hmac-sha256）
 */
export async function generateSignAsync(params: Record<string, any>, apiKey: string, signType: string = 'hmac-sha256'): Promise<string> {
    const normalized = normalizeSignType(signType);
    if (normalized === 'md5') {
        return generateSign(params, apiKey);
    }
    if (normalized === 'hmac-sha256') {
        return hmacSha256(apiKey, buildSignString(params));
    }
    throw new Error('Unsupported sign type');
}

/**
 * 校验 MD5 签名（非 md5 类型一律 false）
 */
export function verifySign(params: Record<string, any>, apiKey: string, sign: string, signType: string = 'md5'): boolean {
    if (normalizeSignType(signType) !== 'md5') {
        return false;
    }
    const expectedSign = generateSign(params, apiKey);
    return expectedSign === sign.toLowerCase();
}

/**
 * 校验签名（异步，支持 md5 / hmac-sha256；rsa 返回 false）
 */
export async function verifySignAsync(params: Record<string, any>, apiKey: string, sign: string, signType: string = 'hmac-sha256'): Promise<boolean> {
    const normalized = normalizeSignType(signType);
    if (normalized === 'rsa') {
        return false;
    }
    try {
        const expectedSign = await generateSignAsync(params, apiKey, normalized);
        return expectedSign === sign.toLowerCase();
    } catch (error) {
        console.error('Verify sign error:', error);
        return false;
    }
}

/**
 * PBKDF2 密码哈希
 * 迭代次数: 77777 次
 */
export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
    const encoder = new TextEncoder();
    if (!salt) {
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        salt = Array.from(saltBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: encoder.encode(salt),
            iterations: 77777, // Cloudflare Workers 限制
            hash: 'SHA-256'
        },
        keyMaterial,
        256
    );
    const hash = Array.from(new Uint8Array(derivedBits)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return { hash, salt };
}

/**
 * 校验密码
 */
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
    const { hash: computedHash } = await hashPassword(password, salt);
    return computedHash === hash;
}

/**
 * AES-GCM 加密（IV 前置拼接后 base64）
 */
export async function aesEncrypt(plaintext: string, key: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key.padEnd(32, '0').slice(0, 32));
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = encoder.encode(plaintext);
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        data
    );
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...result));
}

/**
 * AES-GCM 解密
 */
export async function aesDecrypt(ciphertext: string, key: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key.padEnd(32, '0').slice(0, 32));
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
    );
    const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        encrypted
    );
    return new TextDecoder().decode(decrypted);
}