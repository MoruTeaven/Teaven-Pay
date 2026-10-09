/**
 * 邮件模板：纯字符串拼接，零依赖
 *
 * 注意：模板中的动态内容（用户名、站点名、链接）必须转义后再拼接，
 * 否则用户名里的 HTML 会被带进邮件正文（存储型注入）。
 */

/** HTML 转义（邮件正文用） */
export function escapeHtml(input: unknown): string {
    return String(input == null ? '' : input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface PasswordResetMailInput {
    /** 站点名称 */
    siteName: string;
    /** 收件人显示名（用户名或邮箱） */
    userName: string;
    /** 重置链接（含令牌） */
    resetUrl: string;
    /** 有效期（分钟） */
    expiresMinutes: number;
}

/** 渲染密码找回邮件（返回主题与 HTML 正文） */
export function buildPasswordResetMail(input: PasswordResetMailInput): { subject: string; html: string } {
    const siteName = escapeHtml(input.siteName || 'Teaven Pay');
    const userName = escapeHtml(input.userName || '用户');
    const resetUrl = escapeHtml(input.resetUrl);
    const minutes = Number(input.expiresMinutes) || 30;

    const subject = '【' + (input.siteName || 'Teaven Pay') + '】密码找回';
    const html = [
        '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#111827;">',
        '  <h2 style="margin:0 0 16px;font-size:20px;">' + siteName + ' 密码找回</h2>',
        '  <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#374151;">' + userName + '，您好：</p>',
        '  <p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">我们收到了您的密码重置请求。点击下面的按钮即可设置新密码，链接 ' + minutes + ' 分钟内有效，且只能使用一次。</p>',
        '  <p style="margin:0 0 24px;"><a href="' + resetUrl + '" style="display:inline-block;padding:12px 24px;background:#f59e0b;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">重置密码</a></p>',
        '  <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#6b7280;">如果按钮无法点击，请把下面的链接复制到浏览器打开：</p>',
        '  <p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:#6b7280;word-break:break-all;">' + resetUrl + '</p>',
        '  <p style="margin:0;font-size:13px;line-height:1.7;color:#6b7280;">如果这不是您本人的操作，请忽略本邮件，您的密码不会被修改。</p>',
        '</div>',
    ].join('\n');

    return { subject, html };
}
