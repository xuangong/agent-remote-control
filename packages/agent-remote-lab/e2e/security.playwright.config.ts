import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.AGENT_REMOTE_SECURITY_TEST_PORT ?? 6284);
export default defineConfig({
  testDir: '.', testMatch: 'security.spec.ts', workers: 1, timeout: 30000, expect: { timeout: 5000 },
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure',
    launchOptions: process.env.AGENT_REMOTE_TEST_BROWSER ? { executablePath: process.env.AGENT_REMOTE_TEST_BROWSER } : undefined },
  projects: [{ name: 'security-desktop', use: devices['Desktop Chrome'] }, { name: 'security-mobile', use: devices['Pixel 7'] }],
  webServer: { cwd: fileURLToPath(new URL('../', import.meta.url)), command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
