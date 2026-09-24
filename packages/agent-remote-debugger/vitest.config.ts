import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, include: ['src/**/*.test.ts'], testTimeout: 10000, hookTimeout: 60000 } });
