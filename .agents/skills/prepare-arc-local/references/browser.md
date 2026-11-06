# Operating the website headlessly

The instance signs any local browser in as its local user on the first request.
Use the repository's Playwright with its bundled Chromium, headless, in a new
browser context. Never attach to or open the user's own browsers. Every new
context signs in once, so use one context per script (see the sign-in budget in
the [skill](../SKILL.md#machine-use-and-the-sign-in-budget)).

## Quick screenshot

```bash
pnpm local screenshot / --out .tmp/local/home.png
pnpm local screenshot / --out .tmp/local/phone.png --viewport 390x844
pnpm local screenshot '/?host=HOST&provider=claude&session=ID' --out .tmp/local/session.png --full-page
```

Flags: `<path>` starts with `/` and defaults to `/`; `--out FILE` is required and
a relative path resolves from where you ran pnpm; `--viewport WxH` defaults to
`1440x900`; `--full-page` captures the whole page; `--wait-for CSS` replaces the
default selector. The command waits up to 30 seconds for `main.lab-shell` (or the
`--wait-for` selector) to be visible, then half a second more, saves the image and
prints `Saved <path>`. It signs in once and out again. `HOST` is a Host `id` from
`pnpm --silent local api v1/remote/hosts`. Keep evidence under the checkout's
ignored `.tmp/`.

`Playwright is not ready in <checkout>. …` means Chromium is not installed:
run the `pnpm --filter @orchardworks/agent-remote-lab exec playwright install chromium`
command the message names.

## Scripted interaction

For clicks, typing and assertions, save a short script as
`.tmp/local/<name>.mjs` and run it with `node` from the checkout root. It reads
the origin from `status`, resolves Playwright from the Lab package, uses one
context and signs it out before closing, as `pnpm local screenshot` does:

```javascript
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main.lab-shell').waitFor({ timeout: 30_000 });
    // Act through what the user sees, for example:
    // await page.getByRole('button', { name: 'New session' }).click();
    await page.screenshot({ path: '.tmp/local/step-1.png' });
  } finally {
    // The page's session would otherwise stay open on the instance.
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  }
} finally {
  await browser.close();
}
```

`status --json` exits 3 when the instance is not ready, which makes
`execFileSync` throw; start the instance first. Prefer `getByRole`, `getByLabel`
and visible text over CSS classes, and wait for the expected control or text
instead of fixed sleeps. Browser storage does not persist across contexts;
Windows and other per-user state on the instance do.

If page code fails only in automation, read the console (`page.on('console', …)`)
and network before calling it a product defect.
