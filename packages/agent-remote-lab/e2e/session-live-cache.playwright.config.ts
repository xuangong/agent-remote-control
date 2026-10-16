import { defineConfig, devices } from '@playwright/test';

const relayPort = Number(process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5918);
const webPort = Number(process.env.AGENT_REMOTE_TEST_WEB_PORT ?? 6182);
const origin = `http://127.0.0.1:${webPort}`;
export default defineConfig({
  testDir: '.', testMatch: 'session-live-cache.browser.ts', workers: 1, timeout: 30000, globalTimeout: 120000,
  expect: { timeout: 10000 },
  use: { baseURL: origin, trace: 'retain-on-failure',
    ...(process.env.AGENT_REMOTE_TEST_BROWSER_WS ? { connectOptions: { wsEndpoint: process.env.AGENT_REMOTE_TEST_BROWSER_WS, exposeNetwork: '<loopback>' } } : {}) },
  projects: [{ name: 'webkit-iphone', use: { ...devices['iPhone 13'], browserName: 'webkit' } }],
  webServer: [
    { command: `AGENT_REMOTE_PORT=${relayPort} AGENT_REMOTE_ORIGIN=${origin} pnpm exec tsx e2e/session-live-cache-server.ts`,
      url: `http://127.0.0.1:${relayPort}/v1/providers?protocolVersion=1.8.0`, timeout: 60000, reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }, cwd: new URL('..', import.meta.url).pathname },
    { command: `VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:${relayPort} pnpm exec vite --host ${process.env.AGENT_REMOTE_TEST_WEB_BIND ?? '127.0.0.1'} --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`, timeout: 60000, reuseExistingServer: false, cwd: new URL('..', import.meta.url).pathname },
  ],
});
