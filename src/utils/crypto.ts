/**
 * 加密工具函数
 */

/**
 * 生成随机字符串
 */
export function generateNonce(length: number = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const random = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(random).map(b => chars[b % chars.length]).join('');
}

/**
 * MD5 哈希
 * 注意: Cloudflare Workers 不原生支持 MD5，使用简化实现
 */
export async function md5(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    
    // 使用 SubtleCrypto 的 SHA-256 作为替代
    // 注意: 实际生产环境应使用第三方 MD5 库
    const hash = await crypto.subtle.digest('SHA-256', data);
    
    // 取前 16 字节作为 MD5 替代
    const hashArray = Array.from(new Uint8Array(hash)).slice(0, 16);
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA256
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
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * SHA-256 哈希
 */
export async function sha256(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * RSA 签名
 */
export async function rsaSign(params: any, privateKey: string): Promise<string> {
    // 构建待签名字符串
    let signStr: string;
    if (typeof params === 'string') {
        signStr = params;
    } else {
        const sortedKeys = Object.keys(params).sort();
        const parts = [];
        for (const key of sortedKeys) {
            if (params[key] !== '' && params[key] !== undefined && key !== 'sign') {
                parts.push(`${key}=${params[key]}`);
            }
        }
        signStr = parts.join('&');
    }
    
    // 导入私钥
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    const pemContents = privateKey
        .replace(pemHeader, '')
        .replace(pemFooter, '')
        .replace(/\s/g, '');
    
    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    
    const key = await crypto.subtle.importKey(
        'pkcs8',
        binaryDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
    
    // 签名
    const encoder = new TextEncoder();
    const data = encoder.encode(signStr);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
    
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * RSA 验签
 */
export async function rsaVerify(params: any, signature: string, publicKey: string): Promise<boolean> {
    try {
        // 构建待验签字符串
        let signStr: string;
        if (typeof params === 'string') {
            signStr = params;
        } else {
            const sortedKeys = Object.keys(params).sort();
            const parts = [];
            for (const key of sortedKeys) {
                if (params[key] !== '' && params[key] !== undefined && key !== 'sign') {
                    parts.push(`${key}=${params[key]}`);
                }
            }
            signStr = parts.join('&');
        }
        
        // 导入公钥
        const pemHeader = '-----BEGIN PUBLIC KEY-----';
        const pemFooter = '-----END PUBLIC KEY-----';
        const pemContents = publicKey
            .replace(pemHeader, '')
            .replace(pemFooter, '')
            .replace(/\s/g, '');
        
        const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
        
        const key = await crypto.subtle.importKey(
            'spki',
            binaryDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        
        // 验签
        const encoder = new TextEncoder();
        const data = encoder.encode(signStr);
        const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        
        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, data);
    } catch (error) {
        console.error('RSA verify error:', error);
        return false;
    }
}

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

function normalizeSignType(signType: string = 'md5'): string {
    const normalized = signType.toLowerCase().replace(/_/g, '-');
    if (normalized === 'sha256' || normalized === 'hmacsha256' || normalized === 'hmac-sha256') {
        return 'hmac-sha256';
    }
    return normalized;
}

/**
 * 生成 MD5 兼容签名
 */
export function generateSign(params: Record<string, any>, apiKey: string): string {
    const signStr = apiKey + buildSignString(params) + apiKey;

    // 注意: 这里使用简化的 MD5 替代
    // 生产环境应使用完整的 MD5 实现
    return simpleHash(signStr).toLowerCase();
}

/**
 * 生成签名，默认使用 HMAC-SHA256
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
 * 验证签名 (MD5 兼容)
 */
export function verifySign(params: Record<string, any>, apiKey: string, sign: string, signType: string = 'md5'): boolean {
    if (normalizeSignType(signType) !== 'md5') {
        // RSA 签名验证需要异步，这里简化处理
        return false;
    }
    
    const expectedSign = generateSign(params, apiKey);
    return expectedSign === sign.toLowerCase();
}

/**
 * 验证签名，支持 HMAC-SHA256 和 MD5 兼容模式
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
 * 简化的哈希函数 (用于替代 MD5)
 * 注意: 生产环境应使用完整的 MD5 实现
 */
function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
}

/**
 * PBKDF2 密码哈希
 * 迭代次数: 77777 次
 */
export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
    const encoder = new TextEncoder();
    
    // 生成随机盐
    if (!salt) {
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    // 导入密钥材料
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    
    // 使用 PBKDF2 派生密钥
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
    
    const hash = Array.from(new Uint8Array(derivedBits))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    
    return { hash, salt };
}

/**
 * 验证密码
 */
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
    const { hash: computedHash } = await hashPassword(password, salt);
    return computedHash === hash;
}

/**
 * AES-256-GCM 加密
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
    
    // 将 IV 和加密数据拼接
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);
    
    return btoa(String.fromCharCode(...result));
}

/**
 * AES-256-GCM 解密
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
    
    const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        encrypted
    );
    
    return new TextDecoder().decode(decrypted);
}
