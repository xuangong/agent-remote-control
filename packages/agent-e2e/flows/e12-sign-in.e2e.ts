// E12 of the target architecture: signing in. A session link opened signed out asks to sign in and, after the issuer's page, returns to
// that session with its rows; a returning browser completes the authorization without a click; an access check that is slow when the page
// comes back to the foreground leaves the live session usable. The stack is a Gateway Relay with a sign-in issuer (`signIn`).
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser } from './browser.js';
import { goTo, openSettings, send, showsInput, showsText, waitForKeptConversation } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({
    providerId: 'codex', displayName: 'Codex CLI', signIn: {},
    sessions: {
      work: { title: 'Work', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] },
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

/** The page is on the session of the link: the Relay adds the person's Window to the address. */
const onSession = (address: string) => { const url = new URL(address); return url.origin === stack.origin && url.searchParams.get('session') === 'work' && url.searchParams.get('host') === stack.hostId; };

async function openSignedOut(url: string): Promise<{ context: BrowserContext; page: Page; violations: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const violations: string[] = [];
  page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text()); });
  await page.goto(url);
  return { context, page, violations };
}

it('E12: a session link opened signed out asks to sign in and returns to the session with its rows', async () => {
  stack.gateway!.automaticSignIn = false;
  const { context, page, violations } = await openSignedOut(stack.sessionUrl('work'));
  await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor();
  // The sign-in entry is light: the conversation renderer is not loaded before it is needed.
  const scriptBytes = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => new URL(entry.name).pathname.endsWith('.js')).reduce((sum, entry) => sum + (entry as PerformanceResourceTiming).decodedBodySize, 0));
  expect(scriptBytes).toBeGreaterThan(0);
  expect(scriptBytes).toBeLessThan(300_000);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in as alice' }).click();
  await showsText(page, 'Started');
  expect(onSession(page.url())).toBe(true);
  expect(violations).toEqual([]);
  await send(page, 'after signing in');
  await showsText(page, 'Echo: after signing in');
  await context.close();
});

it('E12: a returning browser completes the authorization without an extra click', async () => {
  stack.gateway!.automaticSignIn = true;
  const { context, page } = await openSignedOut(stack.sessionUrl('work'));
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await showsText(page, 'Started');
  // The next visit is a new tab with the same device storage and no cookie, as a browser that was closed and opened again.
  await context.clearCookies();
  await page.close();
  const returning = await context.newPage();
  returning.setDefaultTimeout(20_000);
  await returning.goto(stack.sessionUrl('work'));
  await showsText(returning, 'Started');
  expect(onSession(returning.url())).toBe(true);
  await context.close();
});

for (const signal of ['visibility', 'pageshow'] as const) {
  it(`E12: a slow access check at the ${signal} of the page leaves the live session usable`, async () => {
    stack.gateway!.automaticSignIn = true;
    const { context, page } = await openSignedOut(stack.sessionUrl('work'));
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await showsText(page, 'Started');
    let sockets = 0;
    const recoveries: string[] = [];
    page.on('websocket', socket => {
      sockets += 1;
      socket.on('framesent', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        const type = frame.type === 'message' ? frame.message.type : frame.type;
        if (['subscribe', 'session_control_request', 'timeline_request'].includes(type)) recoveries.push(type);
      });
    });
    // Sockets opened before this listener do not count: the live session is open once the page is ready to send.
    const input = page.getByTestId('prompt-input');
    await input.fill('Draft before switching apps');
    const editor = await input.elementHandle();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let checking = false;
    await page.route('**/auth/status', async route => { checking = true; await gate; await route.continue(); });
    await page.evaluate(kind => {
      if (kind === 'pageshow') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      else {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    }, signal);
    while (!checking) await new Promise(resolve => setTimeout(resolve, 20));
    await showsInput(page, 'Draft before switching apps');
    expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
    expect(await page.locator('.gateway-recovery').isVisible()).toBe(false);
    await input.fill('Sent before the access check finishes');
    await page.getByTestId('prompt-submit').click();
    await showsText(page, 'Echo: Sent before the access check finishes');
    expect(sockets).toBe(0);
    expect(recoveries).toEqual([]);
    release();
    await context.close();
  });
}

/** What the device holds on disk for the conversations: the stored sessions, drafts and image bytes of the device store, and the content keys of the page's storage. */
const onDisk = (page: Page) => page.evaluate(() => new Promise<{ stores: Record<string, number>; keys: string[] }>(resolve => {
  const keys = [localStorage, sessionStorage].flatMap(storage => Object.keys(storage).filter(key => /^(agent-remote:recovery:|agent-remote-(forks:|ask:|opened:|tracking:|conversation-history)|arc:prompt-edit)/.test(key)));
  const opening = indexedDB.open('agent-remote-image-drafts');
  opening.onerror = () => resolve({ stores: {}, keys });
  opening.onsuccess = () => {
    const database = opening.result, names = [...database.objectStoreNames];
    if (!names.length) { database.close(); resolve({ stores: {}, keys }); return; }
    const transaction = database.transaction(names), stores: Record<string, number> = {};
    for (const name of names) transaction.objectStore(name).count().onsuccess = event => { stores[name] = (event.target as IDBRequest<number>).result; };
    transaction.oncomplete = () => { database.close(); resolve({ stores, keys }); };
  };
}));

it('E12: confirmed device protection removes the disk copies of every tab, keeps the live drafts, and a reload reads the conversation from the Relay', async () => {
  stack.gateway!.automaticSignIn = true;
  const { context, page } = await openSignedOut(stack.sessionUrl('work'));
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await showsText(page, 'Started');
  await waitForKeptConversation(page, 'Started');
  const input = page.getByTestId('prompt-input');
  const published = page.waitForResponse(response => response.url().endsWith('/v1/session-drafts') && response.request().method() === 'POST');
  await input.fill('Private unsent draft');
  await published;
  // A second tab of the same browser on the same session, which has the draft too and has saved it on this device.
  const second = await context.newPage();
  second.setDefaultTimeout(20_000);
  await second.goto(stack.sessionUrl('work'));
  await showsInput(second, 'Private unsent draft');
  await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  while (!(await onDisk(second)).keys.length) await second.waitForTimeout(50);
  await page.bringToFront();

  await openSettings(page, 'Privacy and data');
  await page.getByRole('switch', { name: 'Clear chat cache on close' }).click();
  await page.getByRole('dialog', { name: 'Keep chat data in this page only?' }).getByRole('button', { name: 'Enable protection' }).click();
  await page.getByRole('switch', { name: 'Clear chat cache on close', checked: true }).waitFor();
  const cleared = await onDisk(page);
  expect(Object.values(cleared.stores).every(count => count === 0)).toBe(true);
  expect(cleared.keys).toEqual([]);
  // The other tab learns of it by itself: its copies on disk go, and its draft stays in the page.
  while ((await onDisk(second)).keys.length) await second.waitForTimeout(50);
  await showsInput(second, 'Private unsent draft');
  await second.close();

  // The page that is open keeps what it holds in memory.
  await goTo(page, 'Windows');
  await showsText(page, 'Started');
  await showsInput(page, 'Private unsent draft');

  await page.reload();
  await showsText(page, 'Started');
  // The draft is the account's, shared with every device through the Relay; the device keeps no copy of it, or of the conversation.
  await showsInput(page, 'Private unsent draft');
  const reloaded = await onDisk(page);
  expect(Object.values(reloaded.stores).every(count => count === 0)).toBe(true);
  expect(reloaded.keys).toEqual([]);
  await context.close();
});
