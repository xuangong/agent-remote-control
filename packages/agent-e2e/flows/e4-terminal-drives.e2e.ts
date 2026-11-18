// E4 of the target architecture: a terminal drives a session the page has open. Its rows appear without a send; a terminal that takes the
// session makes the page read-only with control on offer and the refused text kept as a failed message; a Claude session that a terminal wrote to continues
// from the terminal's rows (the divergence finding); a terminal fork is a session of its own in the directory.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, rowTexts } from './browser.js';
import { openAllSessions, showsText, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({
    providerId: 'claude', displayName: 'Claude Code',
    sessions: {
      work: { title: 'Work', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] },
      owned: { title: 'Owned', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] },
      diverging: { title: 'Diverging', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] },
      source: { title: 'Source', history: [{ role: 'user', text: 'Plan it' }, { role: 'assistant', text: 'Planned' }] },
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const composer = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Message', exact: true });

it('E4: a row a terminal writes while the page is open appears without a send', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  const running = stack.provider.session('work');
  expect(running).toBeDefined();
  running!.write('assistant', 'Written from the terminal');
  await showsText(page, 'Written from the terminal');
  expect(running!.sent).toEqual([]);
  await context.close();
});

it('E4: a terminal takes the session, the page turns read-only and offers control, and the refused text is not delivered', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('owned'));
  await showsText(page, 'Started');
  // The page holds control once it has sent; the terminal then takes the session from it.
  await composer(page).fill('first');
  await composer(page).press('Enter');
  await showsText(page, 'Echo: first');
  await stack.provider.terminalTakes('owned');
  await composer(page).fill('too late');
  await composer(page).press('Enter');
  await showsText(page, 'The native client owns this session.');
  await showsText(page, 'Read only');
  expect(stack.provider.session('owned')?.sent).toEqual(['first']);
  expect(await page.getByRole('button', { name: 'Take control', exact: true }).count()).toBe(1);
  // The refused text stays on the page as a failed message that can be retried; nothing reached the provider.
  expect(await page.locator('.agent-outgoing-message', { hasText: 'too late' }).count()).toBe(1);
  await context.close();
});

it('E4: a session a terminal wrote to continues from the terminal\'s rows after the next send', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('diverging'));
  await showsText(page, 'Started');
  stack.provider.terminalWrite('diverging', { role: 'user', text: 'Typed in the terminal' }, { role: 'assistant', text: 'Answered in the terminal' });
  await composer(page).fill('Back in the page');
  await composer(page).press('Enter');
  await showsText(page, 'Echo: Back in the page');
  await showsText(page, 'Answered in the terminal');
  const rows = await rowTexts(page);
  const at = (needle: string) => rows.findIndex(text => text.includes(needle));
  expect(at('Typed in the terminal')).toBeGreaterThan(at('Started'));
  expect(at('Back in the page')).toBeGreaterThan(at('Answered in the terminal'));
  await context.close();
});

it('E4: a terminal fork is a session of its own, with the rows of its source', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/');
  await openAllSessions(page);
  await page.getByLabel('Connected Host').selectOption({ index: 1 });
  await showsText(page, 'Source');
  stack.provider.fork('source', 'source-fork', 'Fork of Source');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await showsText(page, 'Fork of Source');
  await page.getByText('Fork of Source').first().click();
  await waitForEntries(page, 2);
  expect(await rowTexts(page)).toEqual([expect.stringContaining('Plan it'), expect.stringContaining('Planned')]);
  expect(stack.provider.known()).toContain('source-fork');
  await context.close();
});
