import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDnsCache, isBlockedIp, isBlockedIpv4, isBlockedIpv6, isSafeOutboundUrl, isSafeOutboundUrlSync, normalizeHostname } from './netSecurity';

/** 任务 t-mukt0879：SSRF 过滤补 169.254/127.0.0.0-8/DNS 别名 */
describe('netSecurity - IP 段判定', () => {
    it('拦截 127.0.0.0/8 全段（含 127.0.0.2-255）', () => {
        for (const ip of ['127.0.0.1', '127.0.0.2', '127.0.0.255', '127.1.2.3', '127.255.255.255']) {
            expect(isBlockedIpv4(ip)).toBe(true);
        }
    });

    it('拦截 169.254.0.0/16（云元数据）', () => {
        for (const ip of ['169.254.0.1', '169.254.169.254', '169.254.255.255']) {
            expect(isBlockedIpv4(ip)).toBe(true);
        }
        expect(isBlockedIpv4('169.253.0.1')).toBe(false);
        expect(isBlockedIpv4('169.255.0.1')).toBe(false);
    });

    it('拦截私有段与保留段', () => {
        for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
            expect(isBlockedIpv4(ip)).toBe(true);
        }
    });

    it('放行公网地址', () => {
        for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '172.32.0.1', '172.15.0.1']) {
            expect(isBlockedIpv4(ip)).toBe(false);
        }
    });

    it('IPv6 拦截回环/ULA/链路本地/映射内网', () => {
        for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'ff02::1']) {
            expect(isBlockedIpv6(ip)).toBe(true);
        }
        expect(isBlockedIpv6('2400:3200::1')).toBe(false);
    });
});

describe('netSecurity - 同步 URL 校验', () => {
    it('拒绝非 https 协议', () => {
        expect(isSafeOutboundUrlSync('http://example.com/notify').ok).toBe(false);
        expect(isSafeOutboundUrlSync('ftp://example.com/notify').ok).toBe(false);
        expect(isSafeOutboundUrlSync('file:///etc/passwd').ok).toBe(false);
    });

    it('拒绝 localhost 与内网域名', () => {
        for (const host of ['localhost', '127.0.0.1.nip.io', 'metadata.google.internal', 'foo.local', 'bar.internal', '169.254.169.254']) {
            expect(isSafeOutboundUrlSync('https://' + host + '/x').ok).toBe(false);
        }
    });

    it('拒绝整数/十六进制形式的 IP 简写', () => {
        expect(isSafeOutboundUrlSync('https://2130706433/').ok).toBe(false);
        expect(isSafeOutboundUrlSync('https://0x7f000001/').ok).toBe(false);
    });

    it('拒绝携带用户信息的 URL', () => {
        expect(isSafeOutboundUrlSync('https://user:pass@example.com/x').ok).toBe(false);
    });

    it('放行正常公网域名', () => {
        expect(isSafeOutboundUrlSync('https://merchant.example.com/notify').ok).toBe(true);
    });

    it('主机名归一化去掉结尾点与方括号', () => {
        expect(normalizeHostname('Example.COM.')).toBe('example.com');
        expect(normalizeHostname('[::1]')).toBe('::1');
    });
});

describe('netSecurity - DNS 二次校验（防 nip.io 类别名）', () => {
    beforeEach(() => {
        clearDnsCache();
        vi.restoreAllMocks();
    });

    function stubDns(ips: string[] | null) {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: ips !== null,
            json: async () => ({ Answer: (ips || []).map((ip) => ({ type: 1, data: ip })) }),
        })));
    }

    it('DNS 解析到内网 IP 时拒绝（域名本身看起来是公网域名）', async () => {
        stubDns(['169.254.169.254']);
        const result = await isSafeOutboundUrl('https://evil.example.com/notify');
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('169.254.169.254');
    });

    it('DNS 解析到 127.0.0.2 时拒绝', async () => {
        stubDns(['127.0.0.2']);
        const result = await isSafeOutboundUrl('https://alias.example.com/notify');
        expect(result.ok).toBe(false);
    });

    it('DNS 解析到公网 IP 时放行', async () => {
        stubDns(['93.184.216.34']);
        const result = await isSafeOutboundUrl('https://merchant.example.com/notify');
        expect(result.ok).toBe(true);
        expect(result.resolvedIps).toEqual(['93.184.216.34']);
    });

    it('DNS 解析失败时 fail-closed 拒绝', async () => {
        stubDns(null);
        const result = await isSafeOutboundUrl('https://unresolvable.example.com/notify');
        expect(result.ok).toBe(false);
    });

    it('DNS 无 A 记录时拒绝', async () => {
        stubDns([]);
        const result = await isSafeOutboundUrl('https://empty.example.com/notify');
        expect(result.ok).toBe(false);
    });
});
