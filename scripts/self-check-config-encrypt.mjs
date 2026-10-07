// 渠道配置加密逻辑自检 — 验证 AES-GCM 往返 + 明文兼容 + 边界
// 与 src/utils/crypto.ts 的 aesEncrypt/aesDecrypt/encryptChannelConfig/decryptChannelConfig 逻辑一致
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesEncrypt(plaintext, key) {
    const keyData = enc.encode(key.padEnd(32, '0').slice(0, 32));
    const ck = await subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const data = enc.encode(plaintext);
    const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, ck, data);
    const r = new Uint8Array(iv.length + encrypted.byteLength);
    r.set(iv); r.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...r));
}
async function aesDecrypt(ciphertext, key) {
    const keyData = enc.encode(key.padEnd(32, '0').slice(0, 32));
    const ck = await subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
    const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv = data.slice(0, 12), encrypted = data.slice(12);
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, ck, encrypted);
    return dec.decode(decrypted);
}
async function encryptChannelConfig(config, key) {
    if (!key) throw new Error('ENCRYPTION_KEY 未配置');
    return aesEncrypt(JSON.stringify(config), key);
}
async function decryptChannelConfig(stored, key) {
    if (!stored) return {};
    if (stored.trim().startsWith('{')) return JSON.parse(stored);
    if (!key) throw new Error('ENCRYPTION_KEY 未配置');
    return JSON.parse(await aesDecrypt(stored, key));
}

function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('PASS: ' + m); }

const KEY = 'k'.repeat(32);
const config = { appId: 'wx77777777', appSecret: 'secret_leaked_value_xyz', privateKey: '-----BEGIN PRIVATE KEY-----\n...' };

// 1. 往返一致
const cipher = await encryptChannelConfig(config, KEY);
assert(typeof cipher === 'string' && !cipher.includes('appSecret'), '密文不含明文字段名');
const roundtrip = await decryptChannelConfig(cipher, KEY);
assert(JSON.stringify(roundtrip) === JSON.stringify(config), '加密→解密往返一致');

// 2. 兼容明文 JSON（迁移过渡期旧数据可读）
const plain = JSON.stringify(config);
const fromPlain = await decryptChannelConfig(plain, KEY);
assert(JSON.stringify(fromPlain) === JSON.stringify(config), '兼容明文JSON直读(迁移过渡)');

// 3. 密文不被误判为明文
assert(!cipher.trim().startsWith('{'), '密文不以{开头,不会重复加密');

// 4. 空值边界
assert(JSON.stringify(await decryptChannelConfig(null, KEY)) === '{}', 'null → {}');
assert(JSON.stringify(await decryptChannelConfig(undefined, KEY)) === '{}', 'undefined → {}');
assert(JSON.stringify(await decryptChannelConfig('', KEY)) === '{}', '空串 → {}');

// 5. 加密缺 key 抛错（绝不静默存明文）
let threw = false;
try { await encryptChannelConfig(config, undefined); } catch { threw = true; }
assert(threw, '加密缺 ENCRYPTION_KEY 抛错');

// 6. 解密密文缺 key 抛错
threw = false;
try { await decryptChannelConfig(cipher, undefined); } catch { threw = true; }
assert(threw, '解密密文缺 ENCRYPTION_KEY 抛错');

// 7. 每次加密 IV 随机（同明文不同密文）
const c2 = await encryptChannelConfig(config, KEY);
assert(c2 !== cipher, '同明文每次密文不同(IV随机)');

console.log('\n✅ 渠道配置加密自检全部通过');
