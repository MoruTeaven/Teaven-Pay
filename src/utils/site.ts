/**
 * 站点工具函数
 */

/** 站点 URL 缓存 */
let cachedSiteUrl: string | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

/**
 * 获取站点 URL（带缓存）
 */
export async function getSiteUrl(env: any, reqUrl?: string): Promise<string> {
    const now = Date.now();
    if (cachedSiteUrl && now - cacheTime < CACHE_TTL) {
        return cachedSiteUrl;
    }
    try {
        const row = await env.DB.prepare(
            "SELECT value FROM system_config WHERE key = 'site_url'"
        ).first() as any;
        const dbValue = row?.value;
        if (dbValue) {
            const url: string = dbValue.replace(/\/$/, '');
            cachedSiteUrl = url;
            cacheTime = now;
            return url;
        }
    } catch {}
    const fallback = reqUrl ? new URL(reqUrl).origin : '';
    cachedSiteUrl = fallback;
    cacheTime = now;
    return fallback;
}

/**
 * 清除站点 URL 缓存
 */
export function clearSiteUrlCache(): void {
    cachedSiteUrl = null;
    cacheTime = 0;
}
