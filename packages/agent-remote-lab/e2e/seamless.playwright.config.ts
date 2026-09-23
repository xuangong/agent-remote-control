import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: ['seamless-access.spec.ts', 'auth-entry.spec.ts'], workers: 1, timeout: 30000, expect: { timeout: 10000 },
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: devices['Desktop Chrome'] }, { name: 'webkit-iphone', use: { ...devices['iPhone 13'], browserName: 'webkit' } }],
});
