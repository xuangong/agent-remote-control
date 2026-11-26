import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig, devices, type PlaywrightTestProject } from '@playwright/test';

delete process.env.NO_COLOR;

/**
 * The component tier: fixture pages of the Workbench on builder states, with no Relay and no Controller. Only the Vite server of the
 * Workbench runs. `pnpm test:components` runs it; it is a check for layout and component changes and for the end of a step.
 */
const webPort = Number(process.env.AGENT_REMOTE_TEST_WEB_PORT ?? 6175);
const browserExecutable = process.env.AGENT_REMOTE_TEST_BROWSER;

/**
 * Every spec runs in the two Chromium projects, except the phone-*.spec.ts files, which are written for exactly 390 x 844. A spec
 * joins the other projects by naming them in a line of its own, `// Component projects: webkit-desktop, webkit-mobile`, and each
 * project selects the specs that name it, so a new spec never edits this file. A name that is no project fails the run.
 */
const testDir = new URL('./e2e/components/', import.meta.url);
const declared = new Map(readdirSync(testDir).filter(name => name.endsWith('.spec.ts'))
  .map(name => [name, /^\/\/ Component projects: (.+)$/m.exec(readFileSync(new URL(name, testDir), 'utf8'))?.[1]?.split(', ') ?? []] as const));
const specsIn = (project: string) => [...declared].filter(([, projects]) => projects.includes(project)).map(([name]) => name);

const projects: PlaywrightTestProject[] = [
  // The phone-*.spec.ts files are written for exactly 390 x 844 and name the orchard-phone projects below.
  { name: 'chromium-desktop', testIgnore: ['**/phone-*.spec.ts'], use: { ...devices['Desktop Chrome'] } },
  { name: 'chromium-mobile', testIgnore: ['**/phone-*.spec.ts'], use: { ...devices['Pixel 7'] } },
  { name: 'webkit-conversation', testMatch: specsIn('webkit-conversation'), use: { ...devices['Desktop Safari'] } },
  { name: 'webkit-mobile-viewport', testMatch: specsIn('webkit-mobile-viewport'), use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  { name: 'webkit-ask-desktop', testMatch: specsIn('webkit-ask-desktop'), use: { ...devices['Desktop Safari'] } },
  { name: 'webkit-ask-mobile', testMatch: specsIn('webkit-ask-mobile'), use: { ...devices['iPhone 13'] } },
  { name: 'webkit-desktop', testMatch: specsIn('webkit-desktop'), use: { ...devices['Desktop Safari'] } },
  // The phone specs at exactly 390 x 844. Chromium's phone width is covered by chromium-mobile (every other spec runs there), so this
  // project holds only the specs that need Chromium's DevTools touch and safe-area emulation, which WebKit lacks.
  { name: 'orchard-phone-chromium', testMatch: specsIn('orchard-phone-chromium'), use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  { name: 'orchard-phone-webkit', testMatch: specsIn('orchard-phone-webkit'), use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  { name: 'webkit-mobile', testMatch: specsIn('webkit-mobile'), use: { ...devices['iPhone 13'] } },
];
const unknown = [...declared].flatMap(([spec, names]) => names.filter(name => !projects.some(project => project.name === name)).map(name => `${spec} names ${name}`));
if (unknown.length) throw new Error(`No such component project: ${unknown.join('; ')}.`);

export default defineConfig({
  testDir: './e2e/components',
  globalSetup: './e2e/dev-server-warmup.ts',
  fullyParallel: false,
  workers: 1,
  // Under load a layout assertion can miss its window once in many runs; a failure that repeats is still a failure.
  retries: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    trace: 'retain-on-failure',
  },
  projects,
  webServer: {
    // The fixture pages never reach a Relay; the target only has to be a valid address.
    command: `VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:9 pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
