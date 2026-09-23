import { expect, test } from '@playwright/test';
import { sessionLinkFixture } from './session-link-fixture';

test('session sign-in has consistent checking, login, callback and retry pages', async ({ page }, testInfo) => {
  const f = await sessionLinkFixture();
  const target = `/?host=${f.hostId}&provider=recorded&session=linked-session`;
  const violations: string[] = [];
  page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text()); });
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
  let releaseExchange!: () => void;
  const exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve; });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/auth/status', async route => { await checkGate; await route.fulfill({ status: 401, json: {} }); });
    await page.goto(f.url + target);
    await expect(page.getByRole('heading', { name: 'Opening your session' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('01-checking.png') });
    releaseCheck();
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeFocused();
    const signIn = page.getByRole('link', { name: 'Sign in through gateway' });
    await expect(signIn).toHaveAttribute('href', '/auth/login' + target.slice(1));
    await expect(page.locator('[aria-current="step"]')).toContainText('Sign in');
    expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await page.screenshot({ path: testInfo.outputPath('02-sign-in.png') });
    await page.unroute('**/auth/status');
    await page.route('**/auth/session', async route => { await exchangeGate; await route.fulfill({ status: 401, json: {} }); });
    await signIn.click();
    await page.getByRole('link', { name: 'Sign in as alice' }).click();
    await expect(page.getByRole('heading', { name: 'Completing sign-in' })).toBeVisible();
    expect(page.url()).toBe(f.url + '/auth/callback');
    expect(await page.locator('.arc-access').evaluate(element => getComputedStyle(element).display)).toBe('grid');
    // WebKit's screenshot helper injects styles that this callback's strict CSP rejects.
    // Keep the CSP assertion independent of capture instrumentation.
    if (testInfo.project.use.browserName !== 'webkit') await page.screenshot({ path: testInfo.outputPath('03-verifying.png') });
    releaseExchange();
    await expect(page.getByRole('heading', { name: 'Let’s try signing in again' })).toBeVisible();
    const retry = page.getByRole('link', { name: 'Sign in again', exact: true });
    await expect(retry).toHaveAttribute('href', '/auth/login' + target.slice(1));
    await expect(page.getByRole('heading')).toBeFocused();
    if (testInfo.project.use.browserName !== 'webkit') await page.screenshot({ path: testInfo.outputPath('04-expired.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.unroute('**/auth/session');
    await retry.click();
    await page.getByRole('link', { name: 'Sign in as alice' }).click();
    await expect(page).toHaveURL(f.url + target);
    expect(await page.evaluate(() => sessionStorage.getItem('agent-remote-sign-in-return'))).toBeNull();
    expect(violations).toEqual([]);
  } finally { releaseCheck(); releaseExchange(); await f.close(); }
});

test('connection failure offers a real access retry without losing the session link', async ({ page }, testInfo) => {
  const f = await sessionLinkFixture();
  try {
    const target = `/?host=${f.hostId}&provider=recorded&session=linked-session`;
    await page.route('**/auth/status', route => route.fulfill({ status: 503, json: {} }));
    await page.goto(f.url + target);
    await expect(page.getByRole('heading', { name: 'Connection interrupted' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('05-unavailable.png') });
    await page.unroute('**/auth/status');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in through gateway' })).toHaveAttribute('href', '/auth/login' + target.slice(1));
  } finally { await f.close(); }
});

test('a missing ticket or unavailable callback shows recovery and never redirects outside the controller', async ({ page }, testInfo) => {
  const f = await sessionLinkFixture();
  try {
    let exchanges = 0;
    await page.route('**/auth/session', route => { exchanges++; return route.fulfill({ status: 503, json: {} }); });
    await page.goto(f.url + '/auth/callback');
    await expect(page.getByRole('heading', { name: 'Let’s try signing in again' })).toBeVisible();
    expect(exchanges).toBe(0);
    await page.evaluate(() => sessionStorage.setItem('agent-remote-sign-in-return', '//untrusted.example'));
    await page.goto(f.url);
    await page.goto(f.url + '/auth/callback#ticket=expired');
    await expect(page.getByRole('heading', { name: 'Connection interrupted' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in again', exact: true })).toHaveAttribute('href', '/auth/login');
    expect(page.url()).toBe(f.url + '/auth/callback');
    await page.screenshot({ path: testInfo.outputPath('06-callback-unavailable.png') });
  } finally { await f.close(); }
});

test('loads a lightweight sign-in entry before the conversation renderer is needed', async ({ page }) => {
  const f = await sessionLinkFixture();
  try {
    await page.route('**/auth/status', route => route.fulfill({ status: 401, json: {} }));
    await page.goto(f.url);
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    const scriptBytes = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(entry => new URL(entry.name).pathname.endsWith('.js'))
      .reduce((sum, entry) => sum + (entry as PerformanceResourceTiming).decodedBodySize, 0));
    expect(scriptBytes).toBeGreaterThan(0);
    expect(scriptBytes).toBeLessThan(300_000);
  } finally { await f.close(); }
});
