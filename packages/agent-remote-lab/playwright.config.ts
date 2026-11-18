import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

delete process.env.NO_COLOR;

const relayPort = Number(process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910);
const webPort = Number(process.env.AGENT_REMOTE_TEST_WEB_PORT ?? 6175);
const browserExecutable = process.env.AGENT_REMOTE_TEST_BROWSER;
const mode = process.env.AGENT_REMOTE_TEST_INTERACTIONS === '1' ? 'interactions' : process.env.DSH_REPO !== undefined
  ? 'dsh'
  : process.env.BORGEE_CODEX_TEST_EXECUTABLE !== undefined ? 'codex' : 'recorded';
const runtimeEnvironment = `AGENT_REMOTE_PORT=${relayPort} AGENT_REMOTE_ORIGIN=http://127.0.0.1:${webPort}`;
const relayCommand = mode === 'dsh'
  ? `${runtimeEnvironment} BORGEE_LIVE_DSH_RELAY_PORT=${relayPort} BORGEE_LIVE_DSH_WEB_PORT=${webPort} BORGEE_LIVE_DSH_PLAN_MODE=1 pnpm --filter @orchardworks/agent-relay-node exec bash scripts/run-live-dsh.sh`
  : mode === 'codex' ? `${runtimeEnvironment} pnpm --filter @orchardworks/agent-relay-node exec tsx scripts/codex-host-fixture.ts`
  : `${runtimeEnvironment} pnpm --filter @orchardworks/agent-relay-node exec tsx src/${mode}.ts`;
// Fixture Relays default their succession, image and resource state to the home directory, where it would
// accumulate across runs. Live Codex and DSH modes keep the real home for their own credentials and profiles.
const fixtureHome = mode === 'recorded' || mode === 'interactions' ? process.env.TEST_WORKER_INDEX === undefined
  ? mkdtempSync(join(tmpdir(), 'arc-e2e-relay-home-')) : undefined : undefined;
if (fixtureHome) process.on('exit', () => rmSync(fixtureHome, { recursive: true, force: true }));
const scenarioEndpoint = mode === 'recorded' ? '/v1/lab/recorded' : mode === 'dsh' ? '/v1/lab/live' : undefined;
const viteCommand = `${scenarioEndpoint ? `VITE_AGENT_REMOTE_FIXTURE_ENDPOINT=${scenarioEndpoint} ` : ''}VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:${relayPort} pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`;

export default defineConfig({
  testDir: './e2e',
  // The fixture-page specs of the component tier run from playwright.components.config.ts; the specs that start a Relay run from agent-e2e.
  testIgnore: ['**/components/**'],
  ...(mode === 'interactions' ? { testMatch: 'interaction-capabilities.spec.ts' } : {}),
  globalSetup: './e2e/dev-server-warmup.ts',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    // Never green on a phone profile (open item O32): the restoration specs and the two seamless-access tests that need two tabs.
    { name: 'chromium-mobile', testIgnore: ['**/components/**', '**/session-composition-persistence.spec.ts', '**/seamless-access.spec.ts'], use: { ...devices['Pixel 7'] } },
    { name: 'webkit-conversation', testMatch: ['floating-controls-layout.spec.ts'], use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-mobile-viewport', testMatch: ['floating-controls-layout.spec.ts'], use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'webkit-ask-desktop', testMatch: ['window-pane-lifecycle.spec.ts', 'ask-persistence.spec.ts', 'session-composition-persistence.spec.ts', 'bot-mode.spec.ts'], use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-ask-mobile', testMatch: ['window-pane-lifecycle.spec.ts', 'ask-persistence.spec.ts', 'bot-mode.spec.ts'], use: { ...devices['iPhone 13'] } },
  ],
  webServer: [
    {
      command: relayCommand,
      ...(fixtureHome ? { env: { HOME: fixtureHome, USERPROFILE: fixtureHome } } : {}),
      url: `http://127.0.0.1:${relayPort}/v1/providers?protocolVersion=1.8.0`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: viteCommand,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
