import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { defineConfig, devices } from '@playwright/test';
const relayPort = Number(process.env.RESOURCE_BROWSER_RELAY_PORT ?? 63271);
const webPort = Number(process.env.RESOURCE_BROWSER_WEB_PORT ?? 63272);
export default defineConfig({
  testDir: './e2e', testMatch: 'resource-input.spec.ts', fullyParallel: false, workers: 1,
  timeout: 45000, expect: { timeout: 10000 },
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: 'retain-on-failure', launchOptions: process.env.AGENT_REMOTE_TEST_BROWSER ? { executablePath: process.env.AGENT_REMOTE_TEST_BROWSER } : undefined },
  projects: [{ name: 'resource-desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'resource-mobile', use: { ...devices['Pixel 7'] } }],
  webServer: [
    { command: 'pnpm exec tsx scripts/resource-host-fixture.ts', env: { RESOURCE_BROWSER_RELAY_PORT: String(relayPort) }, url: `http://127.0.0.1:${relayPort}/v1/providers?protocolVersion=${PROTOCOL_VERSION}`, reuseExistingServer: false, timeout: 30000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: `pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`, env: { VITE_AGENT_REMOTE_RELAY_TARGET: `http://127.0.0.1:${relayPort}` }, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false, timeout: 30000 },
  ],
});
