import { defineConfig, devices } from '@playwright/test';

delete process.env.NO_COLOR;

/**
 * The native browser tier: the page against a real CLI runtime, run by hand or nightly and never in a gate (`pnpm test:native:browser`).
 * Each spec selects its runtime with an environment variable and is skipped without it:
 * - `BORGEE_CODEX_TEST_EXECUTABLE`: the Codex app-server against its local model-response fixture (`codex.spec.ts`);
 * - `DSH_REPO`: a DeepSeek Harness runtime (`live-dsh.spec.ts`, and `dsh-delivery.spec.ts` with `AGENT_REMOTE_DSH_DELIVERY_FIXTURE=1`).
 * With neither, no server starts and every spec is skipped. The main flows run with `pnpm test:e2e:flows`.
 */
const relayPort = Number(process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910);
const webPort = Number(process.env.AGENT_REMOTE_TEST_WEB_PORT ?? 6175);
// The specs that pair their own Host with the Relay read its address from the environment.
process.env.AGENT_REMOTE_TEST_RELAY_PORT ??= String(relayPort);
process.env.AGENT_REMOTE_TEST_WEB_PORT ??= String(webPort);
const browserExecutable = process.env.AGENT_REMOTE_TEST_BROWSER;
const runtime = process.env.DSH_REPO !== undefined ? 'dsh' : process.env.BORGEE_CODEX_TEST_EXECUTABLE !== undefined ? 'codex' : undefined;
const runtimeEnvironment = `AGENT_REMOTE_PORT=${relayPort} AGENT_REMOTE_ORIGIN=http://127.0.0.1:${webPort}`;
const relayCommand = runtime === 'dsh'
  ? `${runtimeEnvironment} BORGEE_LIVE_DSH_RELAY_PORT=${relayPort} BORGEE_LIVE_DSH_WEB_PORT=${webPort} BORGEE_LIVE_DSH_PLAN_MODE=1 pnpm --filter @orchardworks/agent-relay-node exec bash scripts/run-live-dsh.sh`
  : `${runtimeEnvironment} pnpm --filter @orchardworks/agent-relay-node exec tsx scripts/codex-host-fixture.ts`;
const viteCommand = `${runtime === 'dsh' ? 'VITE_AGENT_REMOTE_FIXTURE_ENDPOINT=/v1/lab/live ' : ''}VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:${relayPort} pnpm --filter @orchardworks/agent-remote-lab exec vite --host 127.0.0.1 --port ${webPort} --strictPort`;

export default defineConfig({
  testDir: './native',
  ...(runtime ? { globalSetup: './native/dev-server-warmup.ts' } : {}),
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: runtime ? [
    { command: relayCommand, url: `http://127.0.0.1:${relayPort}/v1/providers?protocolVersion=1.8.0`, reuseExistingServer: false, timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 } },
    { command: viteCommand, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false, timeout: 120_000 },
  ] : undefined,
});
