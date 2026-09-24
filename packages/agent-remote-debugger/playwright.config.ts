import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30000, globalTimeout: 120000, workers: 1,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure',
    launchOptions: process.env.AGENT_REMOTE_TEST_BROWSER ? { executablePath: process.env.AGENT_REMOTE_TEST_BROWSER } : undefined },
});
