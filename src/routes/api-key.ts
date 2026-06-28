/**
 * API 密钥管理路由
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { generateUUIDv7 } from '../utils/uuid';
import { generateApiKey } from '../utils/crypto';
import { verifyPassword } from '../utils/crypto';

export const apiKeyRouter = new Hono<{ Bindings: Env }>();

/**
 * 获取当前用户的 API 密钥列表
 * GET /api/merchant/api-keys
 */
apiKeyRouter.get('/', async (c) => {
    const payload = c.get('user') as any;

    try {
        const result = await c.env.DB.prepare(
            'SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(payload.id).all();

        const keys = (result.results || []).map((row: any) => ({
            id: row.id,
            name: row.name,
            api_key_preview: row.api_key.substring(0, 8) + '****',
            api_key_type: row.api_key_type,
            status: row.status,
            last_used_at: row.last_used_at,
            created_at: row.created_at,
            updated_at: row.updated_at
        }));

        return c.json({
            code: 0,
            msg: 'success',
            data: keys
        });
    } catch (error) {
        console.error('Get API keys error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 获取单个 API 密钥详情（包含完整密钥）
 * GET /api/merchant/api-keys/:id
 */
apiKeyRouter.get('/:id', async (c) => {
    const payload = c.get('user') as any;
    const { id } = c.req.param();

    try {
        const key = await c.env.DB.prepare(
            'SELECT * FROM api_keys WHERE id = ? AND user_id = ?'
        ).bind(id, payload.id).first();

        if (!key) {
            return c.json({ code: -1, msg: 'API 密钥不存在' });
        }

        return c.json({
            code: 0,
            msg: 'success',
            data: {
                id: (key as any).id,
                name: (key as any).name,
                api_key: (key as any).api_key,
                api_key_type: (key as any).api_key_type,
                rsa_public_key: (key as any).rsa_public_key,
                status: (key as any).status,
                last_used_at: (key as any).last_used_at,
                created_at: (key as any).created_at,
                updated_at: (key as any).updated_at
            }
        });
    } catch (error) {
        console.error('Get API key detail error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 创建新的 API 密钥
 * POST /api/merchant/api-keys
 */
apiKeyRouter.post('/', async (c) => {
    const payload = c.get('user') as any;
    const body = await c.req.parseBody();

    const name = (body.name as string || '').trim();
    const password = body.password as string;
    const apiKeyType = (body.api_key_type as string || 'hmac-sha256').trim();
    const rsaPublicKey = (body.rsa_public_key as string || '').trim();

    // 验证参数
    if (!name) {
        return c.json({ code: -1, msg: '请输入密钥备注名称' });
    }

    if (!password) {
        return c.json({ code: -1, msg: '请输入当前密码' });
    }

    // 验证签名类型
    if (!['md5', 'hmac-sha256', 'rsa'].includes(apiKeyType)) {
        return c.json({ code: -1, msg: '签名类型不合法' });
    }

    // RSA 类型必须提供公钥
    if (apiKeyType === 'rsa' && !rsaPublicKey) {
        return c.json({ code: -1, msg: 'RSA 签名类型需要提供公钥' });
    }

    try {
        // 验证密码
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user) {
            return c.json({ code: -2, msg: '用户不存在' }, 401);
        }

        const valid = await verifyPassword(password, (user as any).password_hash, (user as any).salt);
        if (!valid) {
            return c.json({ code: -1, msg: '密码错误' });
        }

        // 检查密钥数量限制（最多 10 个）
        const countResult = await c.env.DB.prepare(
            'SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?'
        ).bind(payload.id).first();

        if ((countResult as any).count >= 10) {
            return c.json({ code: -1, msg: 'API 密钥数量已达上限（最多 10 个）' });
        }

        // 生成新的 API 密钥
        const newApiKey = await generateApiKey();
        const keyId = generateUUIDv7();
        const now = new Date().toISOString();

        await c.env.DB.prepare(`
            INSERT INTO api_keys (id, user_id, api_key, name, api_key_type, rsa_public_key, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).bind(keyId, payload.id, newApiKey, name, apiKeyType, rsaPublicKey || null, now, now).run();

        // 记录操作日志
        await c.env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, detail, ip, created_at)
            VALUES (?, 'create_api_key', ?, ?, ?)
        `).bind(payload.id, JSON.stringify({ name, key_id: keyId }), c.req.header('CF-Connecting-IP') || '', now).run();

        return c.json({
            code: 0,
            msg: 'API 密钥创建成功',
            data: {
                id: keyId,
                name,
                api_key: newApiKey,
                api_key_type: apiKeyType,
                status: 1,
                created_at: now
            }
        });
    } catch (error) {
        console.error('Create API key error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 更新 API 密钥（备注、状态、签名类型）
 * PUT /api/merchant/api-keys/:id
 */
apiKeyRouter.put('/:id', async (c) => {
    const payload = c.get('user') as any;
    const { id } = c.req.param();
    const body = await c.req.parseBody();

    const name = (body.name as string || '').trim();
    const status = body.status !== undefined ? parseInt(body.status as string) : undefined;
    const apiKeyType = (body.api_key_type as string || '').trim();
    const rsaPublicKey = (body.rsa_public_key as string || '').trim();

    try {
        // 检查密钥是否存在
        const existingKey = await c.env.DB.prepare(
            'SELECT * FROM api_keys WHERE id = ? AND user_id = ?'
        ).bind(id, payload.id).first();

        if (!existingKey) {
            return c.json({ code: -1, msg: 'API 密钥不存在' });
        }

        // 构建更新语句
        const updates: string[] = [];
        const params: any[] = [];

        if (name) {
            updates.push('name = ?');
            params.push(name);
        }

        if (status !== undefined && [0, 1].includes(status)) {
            updates.push('status = ?');
            params.push(status);
        }

        if (apiKeyType && ['md5', 'hmac-sha256', 'rsa'].includes(apiKeyType)) {
            updates.push('api_key_type = ?');
            params.push(apiKeyType);

            if (apiKeyType === 'rsa') {
                if (!rsaPublicKey) {
                    return c.json({ code: -1, msg: 'RSA 签名类型需要提供公钥' });
                }
                updates.push('rsa_public_key = ?');
                params.push(rsaPublicKey);
            } else {
                updates.push('rsa_public_key = NULL');
            }
        }

        if (updates.length === 0) {
            return c.json({ code: -1, msg: '没有需要更新的内容' });
        }

        updates.push("updated_at = datetime('now')");
        params.push(id, payload.id);

        await c.env.DB.prepare(
            `UPDATE api_keys SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
        ).bind(...params).run();

        // 记录操作日志
        const now = new Date().toISOString();
        await c.env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, detail, ip, created_at)
            VALUES (?, 'update_api_key', ?, ?, ?)
        `).bind(payload.id, JSON.stringify({ key_id: id, name, status }), c.req.header('CF-Connecting-IP') || '', now).run();

        return c.json({
            code: 0,
            msg: 'API 密钥更新成功'
        });
    } catch (error) {
        console.error('Update API key error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 删除 API 密钥
 * DELETE /api/merchant/api-keys/:id
 */
apiKeyRouter.delete('/:id', async (c) => {
    const payload = c.get('user') as any;
    const { id } = c.req.param();
    const body = await c.req.parseBody();
    const password = body.password as string;

    if (!password) {
        return c.json({ code: -1, msg: '请输入当前密码' });
    }

    try {
        // 验证密码
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user) {
            return c.json({ code: -2, msg: '用户不存在' }, 401);
        }

        const valid = await verifyPassword(password, (user as any).password_hash, (user as any).salt);
        if (!valid) {
            return c.json({ code: -1, msg: '密码错误' });
        }

        // 检查密钥是否存在
        const existingKey = await c.env.DB.prepare(
            'SELECT * FROM api_keys WHERE id = ? AND user_id = ?'
        ).bind(id, payload.id).first();

        if (!existingKey) {
            return c.json({ code: -1, msg: 'API 密钥不存在' });
        }

        // 检查是否是最后一个密钥
        const countResult = await c.env.DB.prepare(
            'SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?'
        ).bind(payload.id).first();

        if ((countResult as any).count <= 1) {
            return c.json({ code: -1, msg: '不能删除最后一个 API 密钥' });
        }

        // 删除密钥
        await c.env.DB.prepare(
            'DELETE FROM api_keys WHERE id = ? AND user_id = ?'
        ).bind(id, payload.id).run();

        // 记录操作日志
        const now = new Date().toISOString();
        await c.env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, detail, ip, created_at)
            VALUES (?, 'delete_api_key', ?, ?, ?)
        `).bind(payload.id, JSON.stringify({ key_id: id, name: (existingKey as any).name }), c.req.header('CF-Connecting-IP') || '', now).run();

        return c.json({
            code: 0,
            msg: 'API 密钥删除成功'
        });
    } catch (error) {
        console.error('Delete API key error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});

/**
 * 重置 API 密钥（生成新密钥）
 * POST /api/merchant/api-keys/:id/reset
 */
apiKeyRouter.post('/:id/reset', async (c) => {
    const payload = c.get('user') as any;
    const { id } = c.req.param();
    const body = await c.req.parseBody();
    const password = body.password as string;

    if (!password) {
        return c.json({ code: -1, msg: '请输入当前密码' });
    }

    try {
        // 验证密码
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE id = ? AND role = ?'
        ).bind(payload.id, 'merchant').first();

        if (!user) {
            return c.json({ code: -2, msg: '用户不存在' }, 401);
        }

        const valid = await verifyPassword(password, (user as any).password_hash, (user as any).salt);
        if (!valid) {
            return c.json({ code: -1, msg: '密码错误' });
        }

        // 检查密钥是否存在
        const existingKey = await c.env.DB.prepare(
            'SELECT * FROM api_keys WHERE id = ? AND user_id = ?'
        ).bind(id, payload.id).first();

        if (!existingKey) {
            return c.json({ code: -1, msg: 'API 密钥不存在' });
        }

        // 生成新的 API 密钥
        const newApiKey = await generateApiKey();
        const now = new Date().toISOString();

        await c.env.DB.prepare(
            "UPDATE api_keys SET api_key = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
        ).bind(newApiKey, id, payload.id).run();

        // 记录操作日志
        await c.env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, detail, ip, created_at)
            VALUES (?, 'reset_api_key', ?, ?, ?)
        `).bind(payload.id, JSON.stringify({ key_id: id, name: (existingKey as any).name }), c.req.header('CF-Connecting-IP') || '', now).run();

        return c.json({
            code: 0,
            msg: 'API 密钥重置成功',
            data: {
                id,
                api_key: newApiKey
            }
        });
    } catch (error) {
        console.error('Reset API key error:', error);
        return c.json({ code: -5, msg: '系统错误' }, 500);
    }
});
