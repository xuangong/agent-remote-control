// E3 of the target architecture: the page and the Host come back after a socket drop, a Controller restart and a Relay restart; a reload
// paints from the device store before any frame arrives and then catches up; a journal replacement keeps the reader's place (the S4
// reading-anchor finding); older history loads when the reader reaches the top (the Codex older-history finding); one failed fetch of the
// application chunk does not leave the page empty (O27).
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { actAsLocalUser, startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn, resetWindows, rowTexts } from './browser.js';
import { composerOf, holdsText, numberedHistory, rowOffset, send, showsText, timelineScroll, waitForEntries, waitForKeptConversation } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({
    providerId: 'codex', displayName: 'Codex CLI',
    sessions: {
      gone: { title: 'Gone', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Gone answer' }] },
      work: { title: 'Work', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] },
      long: { title: 'Long', history: numberedHistory(40) },
      rewritten: { title: 'Rewritten', history: numberedHistory(60, ' ' + 'padding '.repeat(40)) },
      replaced: { title: 'Replaced', history: numberedHistory(60, ' ' + 'padding '.repeat(40)) },
      older: { title: 'Older', history: numberedHistory(300, ' ' + 'padding '.repeat(60)) },
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E3: the page recovers from a dropped connection and a send is answered', async () => {
  const { context, page, sockets } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  expect(await sockets.drop()).toBeGreaterThan(0);
  await send(page, 'after the drop');
  await showsText(page, 'Echo: after the drop');
  await context.close();
});

it('E3: the page recovers after the Controller and then the Relay restart, and keeps its rows', async () => {
  const { context, page, sockets } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  const before = await rowTexts(page);
  await stack.stopController();
  await stack.startController();
  await send(page, 'after controller restart');
  await showsText(page, 'Echo: after controller restart');
  await sockets.recoveredFrom(() => stack.restartRelay());
  await send(page, 'after relay restart');
  await showsText(page, 'Echo: after relay restart');
  expect((await rowTexts(page)).slice(0, before.length)).toEqual(before);
  await context.close();
});

it('E3: a reload paints the conversation from the device store before any frame arrives, then catches up', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  await waitForKeptConversation(page, 'Started');
  await page.close();
  stack.provider.session('work')!.write('assistant', 'Written while the page was away');
  const { page: returning, sockets } = await openPageIn(context, stack.sessionUrl('work'), { hold: true });
  // The Relay's timeline page is held back, so everything the page shows came from the device.
  await showsText(returning, 'Started');
  expect(await returning.evaluate(() => document.body.innerText.includes('Written while the page was away'))).toBe(false);
  sockets.release();
  await showsText(returning, 'Written while the page was away');
  await context.close();
});

it('E3: older history of a long Codex conversation loads when the reader wheels to the top', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('older'));
  await waitForEntries(page, 10);
  await page.waitForFunction(() => document.body.innerText.includes('Row 300 '));
  const loaded = async () => (await rowTexts(page)).length;
  const initial = await loaded();
  expect(initial).toBeLessThan(300);
  expect((await rowTexts(page)).some(text => text.includes('Row 1 padding'))).toBe(false);
  // The first rows are older than the window the Relay serves. Only a wheel at the top asks for them.
  await timelineScroll(page).hover();
  await expect.poll(async () => {
    await page.mouse.wheel(0, -6000);
    return (await rowTexts(page)).some(text => text.includes('Row 1 padding'));
  }, { timeout: 25_000, interval: 300 }).toBe(true);
  expect(await loaded()).toBeGreaterThan(initial);
  await context.close();
});

it('E3: the reader keeps their line when a row arrives and when the connection drops and returns', async () => {
  const { context, page, sockets } = await openPage(browser, stack.sessionUrl('replaced'));
  await page.waitForFunction(() => document.body.innerText.includes('Row 60 '));
  await timelineScroll(page).hover();
  // Read upwards until Row 30 is in view, and take it as the place to keep.
  await expect.poll(async () => { await page.mouse.wheel(0, -250); const offset = await rowOffset(page, 'Row 30 padding'); return offset !== undefined && offset > 100 && offset < 500; }, { timeout: 20_000, interval: 100 }).toBe(true);
  await page.waitForTimeout(300);
  const before = (await rowOffset(page, 'Row 30 padding'))!;
  const running = stack.provider.session('replaced');
  expect(running).toBeDefined();
  running!.write('assistant', 'Row 61 arrived while reading');
  // The row arrives below the reader's line, where its turn is not rendered: it is found in the timeline.
  await holdsText(page, 'Row 61 arrived while reading');
  expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
  await sockets.recoveredFrom(async () => { await sockets.drop(); });
  running!.write('assistant', 'Row 62 arrived after the drop');
  await holdsText(page, 'Row 62 arrived after the drop');
  expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
  await context.close();
});

it('E3: with smart reading off, the reader keeps their line through a Controller restart (O24), and when smart reading is turned on (O40)', async () => {
  const legacy = await startStack({
    providerId: 'codex', displayName: 'Codex CLI', smartReading: false,
    sessions: { replaced: { title: 'Replaced', history: numberedHistory(60, ' ' + 'padding '.repeat(40)) } },
  });
  try {
    const { context, page } = await openPage(browser, legacy.sessionUrl('replaced'));
    await page.waitForFunction(() => document.body.innerText.includes('Row 60 '));
    await timelineScroll(page).hover();
    await expect.poll(async () => { await page.mouse.wheel(0, -250); const offset = await rowOffset(page, 'Row 30 padding'); return offset !== undefined && offset > 100 && offset < 500; }, { timeout: 20_000, interval: 100 }).toBe(true);
    await page.waitForTimeout(300);
    const before = (await rowOffset(page, 'Row 30 padding'))!;
    await legacy.stopController();
    await legacy.startController();
    await send(page, 'after the restart');
    await holdsText(page, 'Echo: after the restart');
    expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
    // The journal now serves the session: the same rows arrive under their item keys, so every row key changes at once.
    const rowKey = () => page.evaluate(() => document.querySelector<HTMLElement>('[data-entry-key]')?.dataset.entryKey);
    const controllerKey = await rowKey();
    await actAsLocalUser(legacy.origin, async request => {
      const response = await request('PUT', `v1/remote/hosts/${legacy.hostId}/smart-reading`, { providerId: 'codex', enabled: true });
      expect(response.ok).toBe(true);
    });
    await legacy.stopController();
    await legacy.startController();
    await send(page, 'after smart reading');
    await holdsText(page, 'Echo: after smart reading');
    await expect.poll(rowKey, { timeout: 10_000 }).not.toBe(controllerKey);
    expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
    await context.close();
  } finally { await legacy.close(); }
});

// In WebKit too (O54): WebKit keeps a failed `modulepreload` response across reloads, so the Workbench loads its chunks without one.
it('E3: the page shows its rows when the first fetch of the application chunk fails (O27, O54)', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await resetWindows(context, stack.origin);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  let refused = 0;
  await page.route(/\/assets\/App-[^/]*\.js$/, async route => {
    if (refused < 1) { refused += 1; await route.fulfill({ status: 502, body: 'Bad Gateway' }); } else await route.continue();
  });
  await page.goto(stack.sessionUrl('work'), { waitUntil: 'domcontentloaded' });
  await showsText(page, 'Started');
  expect(refused).toBe(1);
  await context.close();
});

it('E3: the reader keeps their line when a Controller restart replaces the journal with a history that changed above them', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('rewritten'));
  await page.waitForFunction(() => document.body.innerText.includes('Row 60 '));
  await timelineScroll(page).hover();
  await expect.poll(async () => { await page.mouse.wheel(0, -250); const offset = await rowOffset(page, 'Row 30 padding'); return offset !== undefined && offset > 100 && offset < 500; }, { timeout: 20_000, interval: 100 }).toBe(true);
  await page.waitForTimeout(300);
  const before = (await rowOffset(page, 'Row 30 padding'))!;
  // The native history now holds a different row 10 and one more row at the end; the rows between keep their keys.
  const changed = numberedHistory(61, ' ' + 'padding '.repeat(40)).map(row => row.key === 'r10' ? { ...row, text: 'Row 10 rewritten while the reader was away' } : row);
  stack.provider.replaceHistory('rewritten', changed);
  await stack.stopController();
  await stack.startController();
  await send(page, 'after the replacement');
  await holdsText(page, 'Echo: after the replacement');
  expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
  // The replacement did arrive: reading up to row 10 shows the rewritten text.
  await timelineScroll(page).hover();
  await expect.poll(async () => { await page.mouse.wheel(0, -1500); return (await rowOffset(page, 'Row 10 rewritten while the reader was away')) !== undefined; }, { timeout: 20_000, interval: 150 }).toBe(true);
  await context.close();
});

it('E3: a session the Host no longer has shows as an empty view that says so, and a new session opens beside it', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('gone'));
  await showsText(page, 'Gone answer');
  await stack.stopController();
  stack.provider.forget('gone');
  await stack.startController();
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The view stays in its Window and says why it is empty, with no composer and no generic error. That the page does not ask for the
  // session again and again is the rule of unavailable-sessions.ts, owned by its unit tests.
  const empty = page.getByRole('status').filter({ hasText: /“Gone” no longer exists on E2E Host/ });
  await empty.waitFor();
  expect(await composerOf(page).count()).toBe(0);
  expect(await page.getByText(/could not find this session/).count()).toBe(0);
  // Its own New session opens a new conversation beside the missing view, which stays in place until it is removed.
  await empty.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByTestId('session-create').click();
  await composerOf(page).waitFor();
  await expect.poll(() => page.getByRole('region', { name: /^Primary group:/ }).count()).toBe(2);
  expect(await empty.count()).toBe(1);
  // The Window keeps the missing view's reference, so it stays a place of its group, next to the new one.
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const windowId = new URL(page.url()).searchParams.get('window')!;
  const { window } = await (await context.request.get(`${stack.origin}${status.basePath}v1/windows/${encodeURIComponent(windowId)}`)).json() as { window: { views: Array<{ placement: string; binding?: { nativeSessionId: string } }> } };
  expect(window.views.filter(view => view.placement === 'primary').map(view => view.binding?.nativeSessionId)).toContain('gone');
  expect(window.views.filter(view => view.placement === 'primary')).toHaveLength(2);
  await context.close();
});
