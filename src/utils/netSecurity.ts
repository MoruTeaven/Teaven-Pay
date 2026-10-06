/** URL 出站安全（SSRF 防护）工具
 *
 * 商户 notify_url / return_url 由商户自行填写，若不做限制会被用来探测
 * 内网与云元数据服务。本模块提供：
 *   1. 协议白名单（默认仅 https）
 *   2. 主机名黑名单（localhost / .local / .internal / 元数据域名 / DNS 别名服务）
 *   3. IP 字面量判定（含 IPv4 私有段、127/8 全段、169.254/16 链路本地、IPv6 等）
 *   4. DNS 解析后二次校验（防 nip.io 等“域名指向内网 IP”的绕过）
 *
 * Cloudflare Workers 无内置 DNS 查询能力，解析走 Cloudflare DoH
 * (https://cloudflare-dns.com/dns-query)。解析失败按 fail-closed 处理，
 * 即拒绝该 URL，避免攻击者用解析超时绕过校验。
 */

/** DoH 解析结果缓存 TTL（毫秒） */
const DNS_CACHE_TTL_MS = 600_000;
/** DoH 缓存最大条目数，超出后整体清空，防止无界增长 */
const DNS_CACHE_MAX_ENTRIES = 1000;
/** DoH 请求超时（毫秒） */
const DNS_LOOKUP_TIMEOUT_MS = 3000;

/** DNS 解析缓存（同 isolate 内复用，进程级无状态） */
const dnsCache = new Map<string, { ips: string[]; expiresAt: number }>();

export interface UrlGuardOptions {
    /** 是否做 DNS 解析二次校验，默认 true */
    dnsCheck?: boolean;
    /** 是否允许 http（不安全，默认 false） */
    allowHttp?: boolean;
}

export interface UrlGuardResult {
    ok: boolean;
    /** 拒绝原因（用于日志） */
    reason?: string;
    /** DNS 解析结果（仅 dnsCheck 开启时） */
    resolvedIps?: string[];
}

/** 已知 DNS 别名 / 回环解析服务，直接拒绝 */
const BLOCKED_HOST_SUFFIXES = [
    'localhost',
    'localhost.localdomain',
    'local',
    'internal',
    'intranet',
    'lan',
    'home.arpa',
    'arpa',
    'metadata.google.internal',
    'metadata.goog',
    'metadata',
    'instance-data',
    'instance-data.ec2.internal',
    'nip.io',
    'xip.io',
    'sslip.io',
    'ip.tools',
    'traefik.me',
    'localtest.me',
    'lvh.me',
    'vcap.me',
    'lacolhost.com',
    'localho.st',
    '127.0.0.1.xip.io',
    '1u.ms',
    'oastify.com',
    'burpcollaborator.net',
    'interact.sh',
    'requestbin.net',
    'pipedream.net',
];

/** 主机名中内嵌 IP 的可疑形态（如 127.0.0.1.nip.io、127-0-0-1.nip.io） */
const EMBEDDED_IP_PATTERNS = [
    /(?:^|\.)(?:\d{1,3}\.){3}\d{1,3}(?:\.|$)/,
    /(?:^|\.)\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}(?:\.|$)/,
    /(?:^|\.)(?:0x[0-9a-f]+|\d+)(?:\.|$)/,
];

/**
 * 校验出站 URL 是否安全（防 SSRF）
 */
export async function isSafeOutboundUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<UrlGuardResult> {
    const { dnsCheck = true, allowHttp = false } = options;

    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
        return { ok: false, reason: 'URL 为空' };
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return { ok: false, reason: 'URL 格式不合法' };
    }

    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
        return { ok: false, reason: `不允许的协议: ${parsed.protocol}` };
    }

    // 用户名密码形式的 URL（https://user:pass@host）易被用于混淆真实主机
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'URL 不允许携带用户信息' };
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) {
        return { ok: false, reason: '主机名为空' };
    }

    // 1) IP 字面量直接判定
    const literalIp = parseIpLiteral(hostname);
    if (literalIp) {
        const blocked = isBlockedIp(literalIp);
        if (blocked) {
            return { ok: false, reason: `内网/保留 IP 被拒绝: ${hostname}` };
        }
        return { ok: true, resolvedIps: [hostname] };
    }

    // 2) 主机名黑名单
    if (isBlockedHostname(hostname)) {
        return { ok: false, reason: `主机名被拒绝: ${hostname}` };
    }

    // 3) DNS 解析后二次校验（防 nip.io 等别名指向内网）
    if (!dnsCheck) {
        return { ok: true };
    }

    const resolved = await resolveHostname(hostname);
    if (!resolved) {
        return { ok: false, reason: `DNS 解析失败: ${hostname}` };
    }
    if (resolved.length === 0) {
        return { ok: false, reason: `DNS 无解析结果: ${hostname}` };
    }

    for (const ip of resolved) {
        if (isBlockedIp(ip)) {
            return { ok: false, reason: `解析到内网/保留 IP: ${hostname} -> ${ip}` };
        }
    }

    return { ok: true, resolvedIps: resolved };
}

/**
 * 仅做同步（无 DNS）校验，用于不希望发起网络请求的场景
 */
export function isSafeOutboundUrlSync(rawUrl: string, options: UrlGuardOptions = {}): UrlGuardResult {
    const { allowHttp = false } = options;

    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
        return { ok: false, reason: 'URL 为空' };
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return { ok: false, reason: 'URL 格式不合法' };
    }

    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
        return { ok: false, reason: `不允许的协议: ${parsed.protocol}` };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'URL 不允许携带用户信息' };
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) {
        return { ok: false, reason: '主机名为空' };
    }

    const literalIp = parseIpLiteral(hostname);
    if (literalIp) {
        return isBlockedIp(literalIp)
            ? { ok: false, reason: `内网/保留 IP 被拒绝: ${hostname}` }
            : { ok: true, resolvedIps: [hostname] };
    }

    if (isBlockedHostname(hostname)) {
        return { ok: false, reason: `主机名被拒绝: ${hostname}` };
    }

    return { ok: true };
}

/** 主机名归一化：小写、去结尾点、去 IPv6 方括号 */
export function normalizeHostname(hostname: string): string {
    let host = (hostname || '').trim().toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
    }
    // 结尾点（FQDN root label）去掉，避免绕过后缀匹配
    while (host.endsWith('.')) {
        host = host.slice(0, -1);
    }
    return host;
}

/** 主机名黑名单判定 */
export function isBlockedHostname(hostname: string): boolean {
    const host = normalizeHostname(hostname);
    if (!host) return true;

    for (const suffix of BLOCKED_HOST_SUFFIXES) {
        if (host === suffix || host.endsWith('.' + suffix)) {
            return true;
        }
    }

    // 内嵌 IP（十进制 / 短横线 / 单整数形式）
    for (const pattern of EMBEDDED_IP_PATTERNS) {
        if (pattern.test(host)) {
            return true;
        }
    }

    // 无点号的主机名（localhost、metadata 等）
    if (!host.includes(':')) {
        const lastLabel = host.split('.').pop() || '';
        if (!host.includes('.') || /^\d+$/.test(lastLabel)) {
            return true;
        }
    }

    return false;
}

/**
 * 解析主机名中的 IP 字面量，返回 IP 字符串；非 IP 返回 null
 */
export function parseIpLiteral(hostname: string): string | null {
    const host = normalizeHostname(hostname);
    if (!host) return null;

    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
        return host;
    }
    // IPv6 字面量（含 ::ffff:1.2.3.4 映射形式）
    if (host.includes(':')) {
        return host;
    }
    // 单整数 / 八进制 / 十六进制形式的 IPv4 简写（http://2130706433/）
    if (/^(0x)?[0-9a-f]+$/i.test(host)) {
        const asIp = integerHostToIpv4(host);
        if (asIp) return asIp;
    }
    return null;
}

/** 判断 IP（IPv4 / IPv6）是否属于内网或保留段 */
export function isBlockedIp(ip: string): boolean {
    const value = (ip || '').trim().toLowerCase();
    if (!value) return true;

    if (value.includes(':')) {
        return isBlockedIpv6(value);
    }
    return isBlockedIpv4(value);
}

/** IPv4 私有 / 保留段判定 */
export function isBlockedIpv4(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return true;

    const octets: number[] = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return true;
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255) return true;
        octets.push(n);
    }

    const [a, b] = octets;

    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // 127.0.0.0/8 全段（含 127.0.0.2-255）
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && octets[2] === 0) return true;   // 192.0.0.0/24
    if (a === 192 && b === 0 && octets[2] === 2) return true;   // 192.0.2.0/24
    if (a === 192 && b === 88 && octets[2] === 99) return true; // 192.88.99.0/24
    if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18.0.0/15
    if (a === 198 && b === 51 && octets[2] === 100) return true;// 198.51.100.0/24
    if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24
    if (a >= 224) return true;                      // 224.0.0.0/4 组播 + 240.0.0.0/4 保留 + 广播

    return false;
}

/** IPv6 私有 / 保留段判定 */
export function isBlockedIpv6(ip: string): boolean {
    const groups = expandIpv6(ip);
    if (!groups) return true;

    // IPv4-mapped (::ffff:a.b.c.d) 与 IPv4-compatible 交给 IPv4 规则
    const mappedIpv4 = extractMappedIpv4(groups);
    if (mappedIpv4) {
        return isBlockedIpv4(mappedIpv4);
    }

    const g0 = groups[0];
    const g1 = groups[1];

    // :: (未指定) / ::1 (回环)
    if (groups.every((g) => g === 0)) return true;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;

    if ((g0 & 0xfe00) === 0xfc00) return true;      // fc00::/7 唯一本地地址
    if ((g0 & 0xffc0) === 0xfe80) return true;      // fe80::/10 链路本地
    if (g0 === 0x2001 && g1 === 0x0db8) return true;// 2001:db8::/32 文档保留
    if (g0 === 0x0064 && (g1 & 0xffc0) === 0xff9b) return true; // 64:ff9b::/96
    if (g0 === 0x0100 && g1 === 0x0000) return true;// 100::/64 discard
    if ((g0 & 0xff00) === 0xff00) return true;      // ff00::/8 组播

    return false;
}

/** 整数型主机名（http://2130706433/）转 IPv4 点分形式 */
function integerHostToIpv4(host: string): string | null {
    let value: number;
    try {
        if (/^0x[0-9a-f]+$/i.test(host)) {
            value = parseInt(host.slice(2), 16);
        } else if (/^0[0-7]+$/.test(host)) {
            value = parseInt(host, 8);
        } else {
            value = parseInt(host, 10);
        }
    } catch {
        return null;
    }
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;

    return [
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
    ].join('.');
}

/** 展开 IPv6 为 8 个 16 位组；解析失败返回 null */
function expandIpv6(ip: string): number[] | null {
    let value = ip.trim().toLowerCase();

    // 去掉 zone id（fe80::1%eth0）
    const zoneIndex = value.indexOf('%');
    if (zoneIndex !== -1) value = value.slice(0, zoneIndex);

    if (value === '::') return [0, 0, 0, 0, 0, 0, 0, 0];

    const halves = value.split('::');
    if (halves.length > 2) return null;

    const parseGroups = (part: string): number[] | null => {
        if (part === '') return [];
        const out: number[] = [];
        for (const chunk of part.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
            out.push(parseInt(chunk, 16));
        }
        return out;
    };

    const head = parseGroups(halves[0] ?? '');
    const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
    if (!head || !tail) return null;

    if (halves.length === 1) {
        return head.length === 8 ? head : null;
    }

    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;

    return [...head, ...new Array(fill).fill(0), ...tail];
}

/** 从展开后的 IPv6 组里取出内嵌 IPv4（::ffff:1.2.3.4 形式） */
function extractMappedIpv4(groups: number[]): string | null {
    const isMapped =
        groups.slice(0, 5).every((g) => g === 0) &&
        (groups[5] === 0xffff || (groups[5] === 0 && groups.slice(0, 6).every((g) => g === 0)));
    if (!isMapped) return null;

    return [
        (groups[6] >>> 8) & 0xff,
        groups[6] & 0xff,
        (groups[7] >>> 8) & 0xff,
        groups[7] & 0xff,
    ].join('.');
}

/**
 * DNS 解析（Cloudflare DoH），带缓存
 * 失败或无结果返回 null，由调用方按 fail-closed 处理
 */
export async function resolveHostname(hostname: string): Promise<string[] | null> {
    const host = normalizeHostname(hostname);
    if (!host) return null;

    const cached = dnsCache.get(host);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.ips;
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DNS_LOOKUP_TIMEOUT_MS);
        const response = await fetch(
            `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
            {
                headers: { accept: 'application/dns-json' },
                signal: controller.signal,
            }
        );
        clearTimeout(timer);

        if (!response.ok) return null;

        const data = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
        const ips = (data.Answer || [])
            .filter((answer) => answer.type === 1 && typeof answer.data === 'string')
            .map((answer) => (answer.data as string).trim())
            .filter(Boolean);

        if (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) {
            dnsCache.clear();
        }
        dnsCache.set(host, { ips, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        return ips;
    } catch {
        return null;
    }
}

/** 清空 DNS 缓存（测试用） */
export function clearDnsCache(): void {
    dnsCache.clear();
}
