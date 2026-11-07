import { createRequire } from 'node:module';
import { join } from 'node:path';

const API_PATH_RULE = 'API paths start with v1/, for example v1/remote/hosts.';

/** A cookie the instance sets only to clear it again (for example the login cookie). */
const clearsCookie = setCookie => /;\s*max-age\s*=\s*(0+|-\d+)\s*(;|$)/i.test(setCookie);

/** Node's fetch hides the real reason (such as ECONNREFUSED) one level down in its cause. */
const failureDetail = error => error?.cause?.message || error?.message || String(error);

/**
 * Runs an action as the instance's local user and signs out afterwards.
 * Every cookie-less request makes the instance sign its local user in, which counts against its sign-in limit
 * (30 per minute, shared with the user's own browser), so one call signs in exactly once.
 */
export async function withUserSession(origin, action) {
  let status;
  try { status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) }); }
  catch (cause) { throw new Error(`Cannot reach the instance at ${origin}: ${failureDetail(cause)}`, { cause }); }
  const cookies = status.headers.getSetCookie().filter(value => !clearsCookie(value)).map(value => value.split(';')[0]);
  const refusal = status.status === 429 ? "The instance's sign-in limit (30 per minute) is exhausted; retry within a minute."
    : !status.ok ? `The instance at ${origin} says its local identity is unavailable (${status.status}).`
    : !cookies.some(cookie => /^[^=]*_session=./.test(cookie)) ? 'The instance did not issue a session cookie.'
    : undefined;
  if (refusal) {
    await status.body?.cancel();
    throw new Error(refusal);
  }
  const headers = { cookie: cookies.join('; '), origin };
  // A session exists from here on, so whatever fails next, it is still signed out.
  try {
    const state = await status.json().catch(() => undefined);
    if (state?.user?.id !== 'devbox' || typeof state.basePath !== 'string' || !state.basePath.startsWith('/u/')) {
      throw new Error(`The instance at ${origin} did not return its local user.`);
    }
    return await action({ basePath: state.basePath, headers });
  } finally {
    const logout = await fetch(origin + '/auth/logout', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    await logout?.body?.cancel();
  }
}

export function signedInUser(origin) {
  return withUserSession(origin, async () => true);
}

/** Allows a pending command line sign-in as the local user, as the Allow button of the approval page does. */
export async function approveCommandLine(origin, code) {
  return withUserSession(origin, async ({ headers }) => {
    const response = await fetch(origin + '/auth/cli', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ code, decision: 'approve' }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== 'approved') {
      throw new Error(`The instance did not allow the command line sign-in (HTTP ${response.status}${result.error ? `: ${result.error}` : ''}).`);
    }
  });
}

export async function userApi(origin, path, { method = 'GET', data } = {}) {
  if (!/^v1\/\S*$/.test(path)) throw new Error(API_PATH_RULE);
  const verb = method.toUpperCase();
  if (data !== undefined && typeof data !== 'string') throw new Error('API data must be a JSON string.');
  if (data !== undefined && (verb === 'GET' || verb === 'HEAD')) throw new Error('GET and HEAD requests cannot carry --data.');
  return withUserSession(origin, async ({ basePath, headers }) => {
    // Dot segments (also percent-encoded) are resolved first, so a path cannot climb out of the user's API into /auth/.
    const url = new URL(basePath + path, origin);
    if (!url.pathname.startsWith(basePath + 'v1/')) throw new Error(API_PATH_RULE);
    const response = await fetch(url, { method: verb, signal: AbortSignal.timeout(30_000),
      headers: data === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: data }) });
    return { status: response.status, body: await response.text() };
  });
}

/** A fresh headless context is signed in by the instance; the user's own browsers are never used. */
export async function screenshot({ source, origin, path = '/', output, viewport = '1440x900', waitFor = 'main.lab-shell', fullPage = false }) {
  const size = /^(\d+)x(\d+)$/.exec(viewport);
  const [width, height] = size ? [Number(size[1]), Number(size[2])] : [];
  if (!(width >= 200 && height >= 200)) throw new Error('Viewport must look like 1440x900.');
  if (!path.startsWith('/')) throw new Error('Page paths start with /.');
  let browser;
  try {
    const { chromium } = createRequire(join(source, 'packages/agent-remote-lab/package.json'))('@playwright/test');
    browser = await chromium.launch({ headless: true });
  } catch (cause) {
    throw new Error(`Playwright is not ready in ${source}. Install dependencies there, then run pnpm --filter @orchardworks/agent-remote-lab exec playwright install chromium.`, { cause });
  }
  try {
    const context = await browser.newContext({ viewport: { width, height } });
    let page;
    try {
      page = await context.newPage();
      try {
        await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: 30_000 });
      } catch (cause) {
        throw new Error(`The page ${origin + path} did not show ${waitFor} within 30 seconds.`, { cause });
      }
      await page.waitForTimeout(500);
      await page.screenshot({ path: output, fullPage });
    } finally {
      // Closed first: an open page keeps polling and would receive 401s once its session ends.
      await page?.close().catch(() => {});
      // The page's session would otherwise stay open on the instance; the context's request client shares its cookies.
      await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
    }
  } finally { await browser.close(); }
}
