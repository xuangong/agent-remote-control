import { defineConfig, devices } from '@playwright/test';

delete process.env.NO_COLOR;

/**
 * The component tier: fixture pages of the Workbench on builder states, with no Relay and no Controller. Only the Vite server of the
 * Workbench runs. `pnpm test:components` runs it; it is a check for layout and component changes and for the end of a step.
 */
const webPort = Number(process.env.AGENT_REMOTE_TEST_WEB_PORT ?? 6175);
const browserExecutable = process.env.AGENT_REMOTE_TEST_BROWSER;

export default defineConfig({
  testDir: './e2e/components',
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
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
    { name: 'webkit-conversation', testMatch: ['tracked-team.spec.ts', 'launcher-layout.spec.ts', 'assistant-view.spec.ts'], use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-mobile-viewport', testMatch: ['layout-diagnostics.spec.ts', 'standalone-layout.spec.ts', 'mobile-viewport-reflow.spec.ts', 'image-atom-touch.spec.ts', 'launcher-layout.spec.ts'], use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'webkit-ask-desktop', testMatch: ['dock-title-interactions.spec.ts', 'session-family-resize.spec.ts', 'tpm-dock.spec.ts', 'session-title-rename.spec.ts', 'ask-timeline-layout.spec.ts', 'session-view-responsive.spec.ts', 'composer-overflow.spec.ts'], use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-ask-mobile', testMatch: ['dock-title-interactions.spec.ts', 'session-family-resize.spec.ts', 'tpm-dock.spec.ts', 'ask-timeline-layout.spec.ts', 'session-view-responsive.spec.ts', 'composer-overflow.spec.ts'], use: { ...devices['iPhone 13'] } },
    { name: 'webkit-desktop', testMatch: ['image-input.spec.ts', 'image-viewer.spec.ts', 'markdown-reading.spec.ts'], use: { ...devices['Desktop Safari'] } },
    // The Orchard primitives and the assistant's conversation at exactly 390 x 844, in Chromium and in mobile WebKit.
    { name: 'orchard-phone-chromium', testMatch: ['orchard-primitives.spec.ts', 'assistant-inventory.spec.ts', 'assistant-conversation.spec.ts', 'tool-approval.spec.ts', 'assistant-view.spec.ts'], use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'orchard-phone-webkit', testMatch: ['orchard-primitives.spec.ts', 'assistant-inventory.spec.ts', 'assistant-conversation.spec.ts', 'tool-approval.spec.ts', 'assistant-view.spec.ts'], use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    { name: 'webkit-mobile', testMatch: ['image-input.spec.ts', 'image-viewer.spec.ts', 'markdown-reading.spec.ts'], use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    // The fixture pages never reach a Relay; the target only has to be a valid address.
    command: `VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:9 pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
