// Vitest 配置（用于安全中间件的自动化验证）
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    },
});
