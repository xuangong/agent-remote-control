// Prints the roles and accessible names of a page of this checkout's local instance, to choose locators from.
// Usage, from the checkout root: node .agents/skills/prepare-arc-local/scripts/page-map.mjs ['/path?query'] [CSS to wait for]
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
const path = process.argv[2] ?? '/';
const waitFor = process.argv[3] ?? 'main.lab-shell';
// Read the origin once: this status call signs in, so never repeat it per step.
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator(waitFor).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    // The ARIA snapshot lists each control as role "name", which getByRole(role, { name, exact: true }) selects.
    process.stdout.write(await page.locator('body').ariaSnapshot() + '\n');
  } finally {
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  }
} finally {
  await browser.close();
}
