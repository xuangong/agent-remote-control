// E13, the page lifecycle of a phone (gap 7 of the requirements review): the browser lifecycle simulator drives a 390 x 844 page through what
// iOS does to it, on the real stack, deterministically: suspended in the background with its socket half-open, a send into a socket that died
// unnoticed, restored from the back-forward cache, and ended by the operating system with a message pending. The clause proven here: a pending
// send survives or is settled, never lost and never sent twice. E13b holds the device's storage. `E2E_BROWSER=webkit` runs them in WebKit.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn, type PageOptions } from './browser.js';
import { composerOf, send, showsInput, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  const opened = (title: string) => ({ title, history: [{ role: 'user' as const, text: 'Start' }, { role: 'assistant' as const, text: `${title} is ready` }] });
  stack = await startStack({
    providerId: 'codex', displayName: 'Codex CLI',
    sessions: { short: opened('Short'), long: opened('Long'), dead: opened('Dead'), cached: opened('Cached'), ended: opened('Ended'), outbox: opened('Outbox') },
  });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const phone: PageOptions = { viewport: { width: 390, height: 844 }, mobile: true };
const userRows = (page: Page, text: string) => page.locator('.agent-message-user', { hasText: text });
const pending = (page: Page, text: string) => page.locator('.agent-outgoing-message', { hasText: text });
/** What the scripted provider received of `text` in session `id`. */
const received = (id: string, text: string) => stack.provider.session(id)?.sent.filter(sent => sent === text).length ?? 0;

async function typeDraft(page: Page, text: string): Promise<void> {
  await composerOf(page).click();
  await page.keyboard.type(text);
  await showsInput(page, text);
}

for (const [label, id, afterMs] of [['10 s', 'short', 10_000], ['10 min', 'long', 600_000]] as const) it(`E13: a page suspended for ${label} with a half-open socket comes back live, with what was written meanwhile and the draft kept, and no connection word`, async () => {
  const { context, page, lifecycle, words } = await openPage(browser, stack.sessionUrl(id), { ...phone, lifecycle: true });
  await showsText(page, `${id === 'short' ? 'Short' : 'Long'} is ready`);
  await typeDraft(page, `Draft kept for ${label}`);
  await lifecycle.suspend({ sockets: 'half-open' });
  stack.provider.session(id)!.write('assistant', `Written during ${label} away`);
  await lifecycle.resume({ afterMs });
  // The socket looks open; the page's probe on return finds it dead within 4 s of page time.
  await lifecycle.advance(4_000);
  await showsText(page, `Written during ${label} away`);
  await showsInput(page, `Draft kept for ${label}`);
  expect(await words.seen()).toEqual([]);
  await context.close();
});

it('E13: a message sent into a socket that died unnoticed comes back from the background to be checked, never sent behind the person\'s back, and Retry delivers it once', async () => {
  const { context, page, lifecycle, sockets } = await openPage(browser, stack.sessionUrl('dead'), { ...phone, lifecycle: true });
  await showsText(page, 'Dead is ready');
  // The connection dies without a word, the person sends, and the phone goes to the background.
  sockets.halfOpen();
  await send(page, 'Sent into a dead socket');
  await pending(page, 'Sent into a dead socket').waitFor();
  await lifecycle.suspend();
  await lifecycle.resume({ afterMs: 30_000 });
  await lifecycle.advance(4_000);
  // The page found the socket dead and connected again. It cannot know whether the send arrived, and the Host cannot tell from this
  // provider's history (gap 5's settlement answers unknown), so the message waits for the person: Delivery not confirmed, with Retry.
  await page.locator('.agent-outgoing-message[data-delivery-state="unconfirmed"]', { hasText: 'Sent into a dead socket' }).waitFor();
  expect(received('dead', 'Sent into a dead socket')).toBe(0);
  await pending(page, 'Sent into a dead socket').getByRole('button', { name: 'Retry message', exact: true }).click();
  await showsText(page, 'Echo: Sent into a dead socket');
  await expect.poll(() => pending(page, 'Sent into a dead socket').count()).toBe(0);
  expect(await userRows(page, 'Sent into a dead socket').count()).toBe(1);
  expect(received('dead', 'Sent into a dead socket')).toBe(1);
  await context.close();
});

it('E13: a page restored from the back-forward cache reconnects, shows what was written meanwhile, keeps its draft and delivers a message once', async () => {
  const { context, page, lifecycle, words } = await openPage(browser, stack.sessionUrl('cached'), { ...phone, lifecycle: true });
  await showsText(page, 'Cached is ready');
  await typeDraft(page, 'After the cache');
  await lifecycle.enterBackForwardCache();
  stack.provider.session('cached')!.write('assistant', 'Written while cached');
  await lifecycle.restoreFromBackForwardCache({ afterMs: 30_000 });
  await showsText(page, 'Written while cached');
  await showsInput(page, 'After the cache');
  await page.locator('[data-testid="prompt-submit"]').click();
  await showsText(page, 'Echo: After the cache');
  expect(await userRows(page, 'After the cache').count()).toBe(1);
  expect(received('cached', 'After the cache')).toBe(1);
  expect(await words.seen()).toEqual([]);
  await context.close();
});

it('E13: a message the Host has not answered when the operating system ends the page comes back with the page and is delivered once', async () => {
  const { context, page, lifecycle } = await openPage(browser, stack.sessionUrl('ended'), { ...phone, lifecycle: true });
  await showsText(page, 'Ended is ready');
  const release = stack.provider.hold();
  try {
    await send(page, 'Pending when the page ended');
    await pending(page, 'Pending when the page ended').waitFor();
    await lifecycle.kill();
    const { page: again } = await openPageIn(context, stack.sessionUrl('ended'));
    await showsText(again, 'Pending when the page ended');
    release();
    await showsText(again, 'Echo: Pending when the page ended');
    await expect.poll(() => pending(again, 'Pending when the page ended').count()).toBe(0);
    expect(await userRows(again, 'Pending when the page ended').count()).toBe(1);
    expect(received('ended', 'Pending when the page ended')).toBe(1);
  } finally { release(); await context.close(); }
});

it('E13: a message waiting for the Host when the operating system ends the page waits on the reopened page and is delivered once the Host is back', async () => {
  const { context, page, lifecycle } = await openPage(browser, stack.sessionUrl('outbox'), { ...phone, lifecycle: true });
  await showsText(page, 'Outbox is ready');
  await stack.stopController();
  try {
    await send(page, 'Waiting when the page ended');
    await page.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Waiting when the page ended[\s\S]*Waiting for E2E Host/.test(node.textContent ?? '')));
    await lifecycle.kill();
    const { page: again } = await openPageIn(context, stack.sessionUrl('outbox'));
    await again.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Waiting when the page ended/.test(node.textContent ?? '')));
    await stack.startController();
    await showsText(again, 'Echo: Waiting when the page ended');
    await expect.poll(() => pending(again, 'Waiting when the page ended').count()).toBe(0);
    expect(await userRows(again, 'Waiting when the page ended').count()).toBe(1);
    expect(received('outbox', 'Waiting when the page ended')).toBe(1);
  } finally { await stack.startController().catch(() => undefined); await context.close(); }
});
