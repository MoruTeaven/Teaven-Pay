/**
 * CORS 工具
 *
 * ALLOWED_ORIGINS 未配置时不再回落到通配符：
 * 站点页面（/pay/:id、/cashier/:id、/admin）都是同源直出，不需要跨源；
 * 开放通配符会让任意站点在受害者浏览器里读取接口响应。
 */

/**
 * 解析 ALLOWED_ORIGINS 配置（逗号分隔，去空白，去掉结尾斜杠）
 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((item) => item.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

/**
 * 判断来源是否允许
 *
 * 未配置白名单时一律拒绝（返回空串 = 不输出 Access-Control-Allow-Origin）。
 * 白名单支持显式配置通配符，以及 https://*.example.com 形式的子域通配。
 */
export function resolveAllowedOrigin(origin: string | undefined | null, allowedOrigins: string[]): string {
    if (!origin) return '';

    if (allowedOrigins.length === 0) {
        return '';
    }
    if (allowedOrigins.includes('*')) {
        return '*';
    }
    if (allowedOrigins.includes(origin)) {
        return origin;
    }

    for (const allowed of allowedOrigins) {
        if (matchWildcard(origin, allowed)) {
            return origin;
        }
    }

    return '';
}

/** 通配子域匹配：https://*.example.com（* 只匹配单个标签） */
function matchWildcard(origin: string, pattern: string): boolean {
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) return false;

    const prefix = pattern.slice(0, starIndex);
    // 保留星号后的点号，确保 * 只覆盖一个标签
    const suffix = pattern.slice(starIndex + 1);
    if (!suffix.startsWith('.')) return false;
    if (!origin.startsWith(prefix)) return false;
    if (!origin.endsWith(suffix)) return false;

    const middle = origin.slice(prefix.length, origin.length - suffix.length);
    // 匹配到的标签不能为空，且不能再含点号或路径分隔符
    return middle.length > 0 && !/[/?#.]/.test(middle);
}
