# Operating the website headlessly

The instance signs any local browser in as its local user on the first request.
Use the repository's Playwright with its bundled Chromium, headless, in a new
browser context. Never attach to or open the user's own browsers, and never use
tools that drive them (DevTools-attached browsers, computer use) for the
instance: use the headless script below. Every new context signs in once, so use
one context per script (see the
[sign-in budget](../SKILL.md#machine-use-and-the-sign-in-budget)).

If Chromium is installed but cannot start, a sandbox is refusing it: see
[Before you start](../SKILL.md#before-you-start). `Playwright is not ready in
<checkout>. …` means dependencies or Chromium are missing; follow the guide's
[troubleshooting table](../../../../docs/local-development.md#troubleshooting).

## Quick screenshot

```bash
pnpm local screenshot / --out .tmp/local/home.png
pnpm local screenshot / --out .tmp/local/phone.png --viewport 390x844
pnpm local screenshot '/?host=HOST&provider=claude&session=ID' --out .tmp/local/session.png --full-page
```

The guide's
[Inspecting the instance](../../../../docs/local-development.md#inspecting-the-instance)
lists the flags. `--out` is required. `HOST` is a Host `id` from
`pnpm --silent local api v1/remote/hosts`. Keep evidence under the checkout's
ignored `.tmp/`. The file is only a capture: open it and say what it shows
([screenshot evidence](verification.md#screenshot-evidence)).

## Scripted interaction

For clicks, typing and assertions, save a short script as
`.tmp/local/<name>.mjs` and run it with `node` from the checkout root. It reads
the origin once, resolves Playwright from the Lab package, uses one context and
signs it out before closing. That sign-out mirrors `screenshot()` in
`scripts/local/session.mjs`:

```javascript
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
// Read the origin once: this status call signs in, so never repeat it per step.
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main.lab-shell').waitFor({ timeout: 30_000 });
    // Act through what the user sees and assert it in the DOM, for example:
    // await page.getByRole('button', { name: 'New session' }).click();
    // await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: '.tmp/local/step-1.png' });
  } finally {
    // Mirrors scripts/local/session.mjs: the page's session would otherwise stay open on the instance.
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  }
} finally {
  await browser.close();
}
```

`status --json` exits 3 when the instance is not ready, which makes
`execFileSync` throw; start the instance first. Prefer `getByRole`, `getByLabel`
and visible text over CSS classes, and wait for the expected control or text
instead of fixed sleeps. Browser storage does not persist across contexts; the
product's Window layouts and other per-user state on the instance do, so a Window
can already hold several session views: scope locators to the view you act in, as
the [test loop](test-loop.md) does.

To start from a session with history, create and drive it with the
[command line](cli.md) and open its `session link` URL with `page.goto`.

If page code fails only in automation, read the console (`page.on('console', …)`)
and network before calling it a product defect.
