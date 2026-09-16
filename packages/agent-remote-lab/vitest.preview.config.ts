import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['e2e/preview.browser.ts'],
  testTimeout: 30_000, hookTimeout: 15_000, maxWorkers: 1 } });
