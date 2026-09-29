/**
 * 等保相关业务日志工具
 */

import { Env } from '../types/env';
import { generateUUIDv7 } from './uuid';

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

export interface RequestLogMeta {
    ip?: string | null;
    userAgent?: string | null;
}

export interface OrderLogInput extends RequestLogMeta {
    orderId: string;
    userId?: string | null;
    outTradeNo?: string | null;
    action: string;
    fromStatus?: number | null;
    toStatus?: number | null;
    amount?: number | null;
    detail?: unknown;
}

export interface PaymentLogInput {
    orderId?: string | null;
    userId?: string | null;
    channelId?: string | null;
    plugin?: string | null;
    direction: 'request' | 'response' | 'internal';
    action: string;
    status: string;
    amount?: number | null;
    thirdPartyTradeNo?: string | null;
    requestData?: unknown;
    responseData?: unknown;
    errorMessage?: string | null;
}

export interface WebhookLogInput extends RequestLogMeta {
    orderId?: string | null;
    userId?: string | null;
    plugin?: string | null;
    webhookType: 'channel_notify' | 'merchant_notify';
    direction: 'inbound' | 'outbound';
    url?: string | null;
    method?: string | null;
    httpStatus?: number | null;
    success: boolean;
    requestHeaders?: unknown;
    requestBody?: unknown;
    responseBody?: unknown;
    errorMessage?: string | null;
}

export interface ReconciliationLogInput {
    userId?: string | null;
    paymentType?: string | null;
    date: string;
    status: 'running' | 'success' | 'failed';
    checkedCount?: number;
    matchedCount?: number;
    mismatchCount?: number;
    fixedCount?: number;
    operatorId?: string | null;
    detail?: unknown;
    errorMessage?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
}

export interface AuditLogInput extends RequestLogMeta {
    userId?: string | null;
    action: string;
    target?: string | null;
    detail?: unknown;
}

const MAX_STRING_LENGTH = 2000;
const MAX_JSON_LENGTH = 8000;
const SENSITIVE_KEYS = ['password', 'passwd', 'secret', 'token', 'authorization', 'api_key', 'apikey', 'private_key', 'key', 'sign', 'salt', 'app_secret', 'appsecret'];

export function getRequestLogMeta(request: Request): RequestLogMeta {
    return {
        ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '',
        userAgent: request.headers.get('User-Agent') || '',
    };
}

export function headersToLogObject(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

export async function logOrderEvent(env: Env, input: OrderLogInput): Promise<void> {
    try {
        await env.DB.prepare(`
            INSERT INTO order_logs (
                id, order_id, user_id, out_trade_no, action, from_status, to_status,
                amount, detail, ip, user_agent, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            generateUUIDv7(),
            input.orderId,
            input.userId || null,
            input.outTradeNo || null,
            input.action,
            input.fromStatus ?? null,
            input.toStatus ?? null,
            input.amount ?? null,
            toLogText(input.detail),
            input.ip || null,
            input.userAgent || null,
            new Date().toISOString()
        ).run();
    } catch (error) {
        console.error('Failed to write order log:', error);
    }
}

export async function logPaymentEvent(env: Env, input: PaymentLogInput): Promise<void> {
    try {
        await env.DB.prepare(`
            INSERT INTO payment_logs (
                id, order_id, user_id, channel_id, plugin, direction, action, status,
                amount, third_party_trade_no, request_data, response_data, error_message, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            generateUUIDv7(),
            input.orderId || null,
            input.userId || null,
            input.channelId || null,
            input.plugin || null,
            input.direction,
            input.action,
            input.status,
            input.amount ?? null,
            input.thirdPartyTradeNo || null,
            toLogText(input.requestData),
            toLogText(input.responseData),
            input.errorMessage ? truncate(input.errorMessage, MAX_STRING_LENGTH) : null,
            new Date().toISOString()
        ).run();
    } catch (error) {
        console.error('Failed to write payment log:', error);
    }
}

export async function logWebhookEvent(env: Env, input: WebhookLogInput): Promise<void> {
    try {
        await env.DB.prepare(`
            INSERT INTO webhook_logs (
                id, order_id, user_id, plugin, webhook_type, direction, url, method,
                http_status, success, request_headers, request_body, response_body,
                error_message, ip, user_agent, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            generateUUIDv7(),
            input.orderId || null,
            input.userId || null,
            input.plugin || null,
            input.webhookType,
            input.direction,
            input.url || null,
            input.method || null,
            input.httpStatus ?? null,
            input.success ? 1 : 0,
            toLogText(input.requestHeaders),
            toLogText(input.requestBody),
            toLogText(input.responseBody),
            input.errorMessage ? truncate(input.errorMessage, MAX_STRING_LENGTH) : null,
            input.ip || null,
            input.userAgent || null,
            new Date().toISOString()
        ).run();
    } catch (error) {
        console.error('Failed to write webhook log:', error);
    }
}

export async function logReconciliationEvent(env: Env, input: ReconciliationLogInput): Promise<string | null> {
    const id = generateUUIDv7();

    try {
        await env.DB.prepare(`
            INSERT INTO reconciliation_logs (
                id, user_id, payment_type, date, status, checked_count, matched_count,
                mismatch_count, fixed_count, operator_id, detail, error_message,
                started_at, finished_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            id,
            input.userId || null,
            input.paymentType || null,
            input.date,
            input.status,
            input.checkedCount ?? 0,
            input.matchedCount ?? 0,
            input.mismatchCount ?? 0,
            input.fixedCount ?? 0,
            input.operatorId || null,
            toLogText(input.detail),
            input.errorMessage ? truncate(input.errorMessage, MAX_STRING_LENGTH) : null,
            input.startedAt || null,
            input.finishedAt || null,
            new Date().toISOString()
        ).run();

        return id;
    } catch (error) {
        console.error('Failed to write reconciliation log:', error);
        return null;
    }
}

export async function logAuditEvent(env: Env, input: AuditLogInput): Promise<void> {
    try {
        await env.DB.prepare(`
            INSERT INTO operation_logs (user_id, action, target, detail, ip, user_agent, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
            input.userId || null,
            input.action,
            input.target || null,
            toLogText(input.detail) || '{}',
            input.ip || null,
            input.userAgent || null,
            new Date().toISOString()
        ).run();
    } catch (error) {
        console.error('Failed to write audit log:', error);
    }
}

function toLogText(value: unknown): string | null {
    if (value === undefined || value === null) return null;

    try {
        return truncate(JSON.stringify(sanitizeForLog(value)), MAX_JSON_LENGTH);
    } catch {
        return truncate(String(value), MAX_STRING_LENGTH);
    }
}

function sanitizeForLog(value: unknown, depth = 0): JsonLike {
    if (depth > 6) return '[MaxDepth]';
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return truncate(value, MAX_STRING_LENGTH);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof URLSearchParams) return sanitizeForLog(Object.fromEntries(value.entries()), depth + 1);
    if (value instanceof Headers) return sanitizeForLog(headersToLogObject(value), depth + 1);
    if (value instanceof File) return `[File:${value.name}:${value.size}]`;
    if (Array.isArray(value)) return value.map(item => sanitizeForLog(item, depth + 1));

    if (typeof value === 'object') {
        const result: Record<string, JsonLike> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (isSensitiveKey(key)) {
                result[key] = '[REDACTED]';
            } else {
                result[key] = sanitizeForLog(item, depth + 1);
            }
        }
        return result;
    }

    return truncate(String(value), MAX_STRING_LENGTH);
}

function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    return SENSITIVE_KEYS.some(item => normalized === item.replace(/[-_]/g, ''));
}

function truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
}
