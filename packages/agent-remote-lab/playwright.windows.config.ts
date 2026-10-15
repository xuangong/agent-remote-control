import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'window-workspaces.spec.ts', workers: 1,
  timeout: 90000, globalTimeout: 180000, expect: { timeout: 10000 },
  use: { actionTimeout: 10000, navigationTimeout: 15000, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: process.env.AGENT_REMOTE_TEST_BROWSER ? { executablePath: process.env.AGENT_REMOTE_TEST_BROWSER } : undefined } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
