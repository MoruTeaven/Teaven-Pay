/**
 * 支付宝 RSA2 签名 / 验签工具（Cloudflare Workers / Web Crypto）
 *
 * 项目运行在 Workers 上，不能引入依赖 Node.js 的官方 alipay-sdk，
 * 这里用 Web Crypto 直接实现统一收单所需的 RSA2（SHA256withRSA）签名与验签。
 * 私钥同时兼容 PKCS#8（BEGIN PRIVATE KEY）与 PKCS#1（BEGIN RSA PRIVATE KEY）。
 */

/** 支付宝时间戳：yyyy-MM-dd HH:mm:ss，按支付宝要求使用北京时间（UTC+8） */
export function formatAlipayTimestamp(date: Date = new Date()): string {
    const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ` +
        `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`;
}

/**
 * 构造支付宝待签名串：参数名 ASCII 字典序，跳过 sign 与空值，k=v 以 & 连接。
 * 支付宝要求实际请求、签名内容、验签三方参数完全一致，因此统一走此函数。
 */
export function buildAlipaySignString(params: Record<string, any>): string {
    return Object.keys(params)
        .sort()
        .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map((key) => `${key}=${params[key]}`)
        .join('&');
}

/** DER 长度编码（支付宝密钥为 2048 位，长度会超过 127，需长格式） */
function derLength(len: number): Uint8Array {
    if (len < 0x80) return Uint8Array.of(len);
    const bytes: number[] = [];
    let n = len;
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n >>= 8;
    }
    return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derWrap(tag: number, content: Uint8Array): Uint8Array {
    const len = derLength(content.length);
    const out = new Uint8Array(1 + len.length + content.length);
    out[0] = tag;
    out.set(len, 1);
    out.set(content, 1 + len.length);
    return out;
}

function pemToDer(pem: string): Uint8Array {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * PKCS#1（BEGIN RSA PRIVATE KEY）→ PKCS#8（PrivateKeyInfo）。
 * Web Crypto 的 subtle.importKey 只接受 pkcs8 / spki / jwk，
 * 直接导入 PKCS#1 会报格式错误，这里补上标准 ASN.1 外层包装。
 */
function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
    // AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
    const algId = Uint8Array.of(
        0x30, 0x0d,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
        0x05, 0x00
    );
    const version = Uint8Array.of(0x02, 0x01, 0x00);
    const privateKeyOctet = derWrap(0x04, pkcs1Der);
    const content = new Uint8Array(version.length + algId.length + privateKeyOctet.length);
    content.set(version, 0);
    content.set(algId, version.length);
    content.set(privateKeyOctet, version.length + algId.length);
    return derWrap(0x30, content);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** RSA2 私钥签名，返回 base64 */
export async function alipaySign(params: Record<string, any> | string, privateKey: string): Promise<string> {
    const signStr = typeof params === 'string' ? params : buildAlipaySignString(params);
    const der = pemToDer(privateKey);
    const pkcs8 = /-----BEGIN PRIVATE KEY-----/.test(privateKey) ? der : pkcs1ToPkcs8(der);
    const key = await crypto.subtle.importKey(
        'pkcs8',
        toArrayBuffer(pkcs8),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signStr));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/** RSA2 公钥验签（支付宝公钥），signature 为 base64 */
export async function alipayVerify(signStr: string, signature: string, alipayPublicKey: string): Promise<boolean> {
    try {
        const der = pemToDer(alipayPublicKey);
        const key = await crypto.subtle.importKey(
            'spki',
            toArrayBuffer(der),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        const signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
        return await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            key,
            signatureBytes,
            new TextEncoder().encode(signStr)
        );
    } catch {
        return false;
    }
}

/**
 * 从 JSON 文本里提取某个键对应的原始 JSON 子串（保留原始空格/转义）。
 * 支付宝服务端响应的 sign 是对 "<method>_response" 的原始 JSON 值签名，
 * 重新 JSON.stringify 会因键序或空格差异导致验签失败，必须取原始片段。
 */
export function extractRawJsonValue(text: string, key: string): string | null {
    const marker = `"${key}"`;
    const idx = text.indexOf(marker);
    if (idx < 0) return null;
    const colon = text.indexOf(':', idx + marker.length);
    if (colon < 0) return null;
    let i = colon + 1;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{' && text[i] !== '[') return null;

    const open = text[i];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) return text.slice(i, j + 1);
        }
    }
    return null;
}
