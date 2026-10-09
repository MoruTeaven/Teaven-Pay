import { describe, expect, it } from 'vitest';
import { buildPasswordResetMail, escapeHtml } from './mailTemplates';

/** 任务 t-mv0w9c3h-wx1xft：密码找回邮件模板 */
describe('escapeHtml', () => {
    it('转义 HTML 元字符', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(escapeHtml('"a" & \'b\'')).toBe('&quot;a&quot; &amp; &#39;b&#39;');
    });

    it('空值安全', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('buildPasswordResetMail', () => {
    const base = {
        siteName: 'Teaven Pay',
        userName: 'shop77',
        resetUrl: 'https://pay.example.com/reset-password?token=abc123',
        expiresMinutes: 30,
    };

    it('主题包含站点名', () => {
        const mail = buildPasswordResetMail(base);
        expect(mail.subject).toContain('Teaven Pay');
        expect(mail.subject).toContain('密码找回');
    });

    it('正文包含重置链接与有效期', () => {
        const mail = buildPasswordResetMail(base);
        expect(mail.html).toContain(base.resetUrl);
        expect(mail.html).toContain('30');
        expect(mail.html).toContain('shop77');
    });

    it('用户名中的 HTML 被转义（防邮件正文注入）', () => {
        const mail = buildPasswordResetMail({ ...base, userName: '<img src=x onerror=alert(1)>' });
        expect(mail.html).not.toContain('<img src=x');
        expect(mail.html).toContain('&lt;img src=x');
    });

    it('链接中的引号被转义，无法逃出 href 属性', () => {
        const mail = buildPasswordResetMail({ ...base, resetUrl: 'https://a.test/x?token="><script>alert(1)</script>' });
        expect(mail.html).not.toContain('"><script>');
        expect(mail.html).toContain('&quot;&gt;&lt;script&gt;');
    });

    it('站点名缺省时回退为 Teaven Pay', () => {
        const mail = buildPasswordResetMail({ ...base, siteName: '' });
        expect(mail.subject).toContain('Teaven Pay');
    });
});
