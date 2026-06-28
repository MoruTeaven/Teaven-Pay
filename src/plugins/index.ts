/**
 * 支付插件管理
 */

import { PaymentPlugin } from '../types/plugin';
import { AlipayPlugin } from './alipay';
import { WxpayPlugin } from './wxpay';
import { QQPayPlugin } from './qqpay';
import { XunhupayPlugin } from './xunhupay';

// 插件注册表
const plugins: Record<string, () => PaymentPlugin> = {
    'alipay': () => new AlipayPlugin(),
    'wxpay': () => new WxpayPlugin(),
    'qqpay': () => new QQPayPlugin(),
    'xunhupay': () => new XunhupayPlugin(),
};

/**
 * 获取支付插件实例
 */
export function getPlugin(pluginId: string): PaymentPlugin {
    const pluginFactory = plugins[pluginId];
    if (!pluginFactory) {
        throw new Error(`Payment plugin not found: ${pluginId}`);
    }
    return pluginFactory();
}

/**
 * 注册新的支付插件
 */
export function registerPlugin(pluginId: string, factory: () => PaymentPlugin): void {
    plugins[pluginId] = factory;
}

/**
 * 获取所有已注册的插件 ID
 */
export function getRegisteredPlugins(): string[] {
    return Object.keys(plugins);
}

/**
 * 获取所有插件信息（ID 和名称）
 */
export function getPluginList(): Array<{ id: string; name: string }> {
    return Object.entries(plugins).map(([id, factory]) => {
        const plugin = factory();
        return { id, name: plugin.name };
    });
}

/**
 * 检查插件是否存在
 */
export function hasPlugin(pluginId: string): boolean {
    return pluginId in plugins;
}
