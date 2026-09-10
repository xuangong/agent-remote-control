import { defineConfig, devices } from '@playwright/test';

delete process.env.NO_COLOR;

const relayPort = Number(process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910);
const webPort = Number(process.env.AGENT_REMOTE_TEST_WEB_PORT ?? 6175);
const browserExecutable = process.env.AGENT_REMOTE_TEST_BROWSER;
const mode = process.env.AGENT_REMOTE_TEST_INTERACTIONS === '1' ? 'interactions' : process.env.DSH_REPO !== undefined
  ? 'dsh'
  : process.env.BORGEE_CODEX_TEST_EXECUTABLE !== undefined ? 'codex' : 'recorded';
const runtimeEnvironment = `AGENT_REMOTE_PORT=${relayPort} AGENT_REMOTE_ORIGIN=http://127.0.0.1:${webPort}`;
const relayCommand = mode === 'dsh'
  ? `${runtimeEnvironment} BORGEE_LIVE_DSH_RELAY_PORT=${relayPort} BORGEE_LIVE_DSH_WEB_PORT=${webPort} BORGEE_LIVE_DSH_PLAN_MODE=1 scripts/run-live-dsh.sh`
  : `${runtimeEnvironment} pnpm exec tsx src/server/${mode}.ts`;
const scenarioEndpoint = mode === 'recorded' ? '/v1/lab/recorded' : mode === 'dsh' ? '/v1/lab/live' : undefined;
const viteCommand = `${scenarioEndpoint ? `VITE_AGENT_REMOTE_FIXTURE_ENDPOINT=${scenarioEndpoint} ` : ''}VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:${relayPort} pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`;

export default defineConfig({
  testDir: './e2e',
  ...(mode === 'interactions' ? { testMatch: 'interaction-capabilities.spec.ts' } : {}),
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: relayCommand,
      url: `http://127.0.0.1:${relayPort}/v1/providers?protocolVersion=1.4.0`,
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
