import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Runs an action as the instance's local user; every local request is signed in, and signed out afterwards. */
export async function withUserSession(origin, action) {
  const status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) });
  if (!status.ok) {
    await status.body?.cancel();
    throw new Error(`The local identity is unavailable (${status.status}).`);
  }
  const state = await status.json();
  if (state.user?.id !== 'devbox' || typeof state.basePath !== 'string' || !state.basePath.startsWith('/u/')) {
    throw new Error('The instance did not sign in its local user.');
  }
  const headers = { cookie: status.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin };
  try { return await action({ basePath: state.basePath, headers }); }
  finally {
    const logout = await fetch(origin + '/auth/logout', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    await logout?.body?.cancel();
  }
}

export function signedInUser(origin) {
  return withUserSession(origin, async () => true);
}

export async function userApi(origin, path, { method = 'GET', data } = {}) {
  if (!/^v1\/\S*$/.test(path)) throw new Error('API paths start with v1/, for example v1/remote/hosts.');
  return withUserSession(origin, async ({ basePath, headers }) => {
    const response = await fetch(origin + basePath + path, { method, signal: AbortSignal.timeout(30_000),
      headers: data === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: data }) });
    return { status: response.status, body: await response.text() };
  });
}

/** A fresh headless context is signed in by the instance; the user's own browsers are never used. */
export async function screenshot({ source, origin, path = '/', output, viewport = '1440x900', waitFor = 'main.lab-shell', fullPage = false }) {
  const [width, height] = viewport.split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200) throw new Error('Viewport must look like 1440x900.');
  if (!path.startsWith('/')) throw new Error('Page paths start with /.');
  const { chromium } = createRequire(join(source, 'packages/agent-remote-lab/package.json'))('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: output, fullPage });
  } finally { await browser.close(); }
}
