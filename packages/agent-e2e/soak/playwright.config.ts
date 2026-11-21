import { defineConfig, devices } from '@playwright/test';

/**
 * The Stage 7 soak, run by hand (see packages/agent-remote-lab/performance/README.md): `ARC_SOAK_MINUTES=60 pnpm exec playwright test --config=soak/playwright.config.ts`
 * from this package. It starts no server: the spec's fixture runs a hosted Relay, two Controllers and the built Workbench itself, so this
 * config is not part of `pnpm test:e2e:flows` or any other tier.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'soak.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } }],
});
