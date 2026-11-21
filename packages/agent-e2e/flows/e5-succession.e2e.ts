// E5 of the target architecture: a session is handed to a successor, the conversation continues there, and a page refreshed in the middle
// of the handoff recovers. The Controller has its real succession state; the scripted provider gives the evidence a successor needs.
// A session that was handed off is superseded for good, and the Relay keeps the handoff with the user, so each flow has a stack of its own.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack, type StackOptions } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { closeDetails, holdsText, send, sessionsList, showsText } from './page.js';

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });

/** A stack whose `origin` session may be handed off; `gate` holds the creation of the successor until it is released. */
async function handoffStack(options: { otherProviders?: StackOptions['otherProviders'] } = {}) {
  let release = () => {};
  let hold = Promise.resolve();
  let entered = false;
  const stack: Stack = await startStack({
    sessions: { origin: { title: 'Origin', history: [{ role: 'user', text: 'Original requirement' }, { role: 'assistant', text: 'Original answer' }] } },
    succession: { beforeCreate: async () => { entered = true; await hold; } },
    ...(options.otherProviders ? { otherProviders: options.otherProviders } : {}),
  });
  return { stack, holdCreation() { hold = new Promise<void>(resolve => { release = resolve; }); }, release: () => release(), entered: () => entered };
}

const handoffDialog = (page: Page) => page.getByRole('dialog', { name: 'Hand off conversation' });
async function startHandoff(page: Page): Promise<void> {
  await page.locator('[data-testid="prompt-input"]').click();
  await page.keyboard.type('/handoff');
  await page.keyboard.press('Enter');
  await handoffDialog(page).getByRole('button', { name: 'Hand off', exact: true }).click();
}
const successorUrl = (page: Page) => new URL(page.url()).searchParams.get('session');

it('E5: the page hands the session to a successor that carries the earlier conversation into its first message', async () => {
  const { stack } = await handoffStack();
  try {
    const { context, page } = await openPage(browser, stack.sessionUrl('origin'));
    await showsText(page, 'Original answer');
    await startHandoff(page);
    await expect.poll(() => successorUrl(page), { timeout: 25_000 }).not.toBe('origin');
    const successor = successorUrl(page)!;
    // The assistant's details list the session it continued from.
    await (await sessionsList(page)).locator('ol.lab-assistant-chain a[href*="session=origin"]').waitFor();
    await closeDetails(page);
    // The handoff itself sends nothing; the first message the person writes carries the quoted history once.
    expect(stack.provider.session(successor)?.sent ?? []).toEqual([]);
    await send(page, 'First message on the successor');
    await showsText(page, 'Echo: ');
    const first = stack.provider.session(successor)!.sent[0]!;
    expect(first).toContain('Original requirement');
    expect(first).toContain('First message on the successor');
    await context.close();
  } finally { await stack.close(); }
});

it('E5: after the first message the conversation continues on the successor alone', async () => {
  const { stack } = await handoffStack();
  try {
    const { context, page } = await openPage(browser, stack.sessionUrl('origin'));
    await showsText(page, 'Original answer');
    await startHandoff(page);
    await expect.poll(() => successorUrl(page), { timeout: 25_000 }).not.toBe('origin');
    const successor = successorUrl(page)!;
    await send(page, 'First');
    await showsText(page, 'Echo: ');
    await send(page, 'Second plain message');
    await showsText(page, 'Echo: Second plain message');
    expect(stack.provider.session(successor)!.sent[1]).toBe('Second plain message');
    expect(stack.provider.session('origin')?.sent ?? []).toEqual([]);
    await context.close();
  } finally { await stack.close(); }
});

it('E5: a page refreshed while the handoff is half done keeps the conversation, then commits the handoff that was prepared', async () => {
  const handoff = await handoffStack();
  const { stack } = handoff;
  try {
    handoff.holdCreation();
    const { context, page } = await openPage(browser, stack.sessionUrl('origin'));
    await showsText(page, 'Original answer');
    await startHandoff(page);
    await expect.poll(handoff.entered).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await showsText(page, 'Original answer');
    handoff.release();
    await showsText(page, 'Handoff is ready');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('button', { name: 'Commit Handoff', exact: true }).click();
    await expect.poll(() => successorUrl(page), { timeout: 25_000 }).not.toBe('origin');
    await (await sessionsList(page)).locator('ol.lab-assistant-chain a[href*="session=origin"]').waitFor();
    await closeDetails(page);
    await send(page, 'After the refresh');
    await showsText(page, 'Echo: ');
    await context.close();
  } finally { await stack.close(); }
});

it('E5: a handoff to another provider continues the assistant there, keeps the earlier conversation readable, and sends only to the successor', async () => {
  const { stack } = await handoffStack({ otherProviders: [{ providerId: 'claude', displayName: 'Claude' }] });
  try {
    const claude = stack.otherProviders[0]!;
    const { context, page } = await openPage(browser, stack.sessionUrl('origin'));
    await showsText(page, 'Original answer');
    await page.locator('[data-testid="prompt-input"]').click();
    await page.keyboard.type('/handoff');
    await page.keyboard.press('Enter');
    const dialog = handoffDialog(page);
    await dialog.getByRole('combobox', { name: 'Successor provider', exact: true }).selectOption('claude');
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
    await expect.poll(() => successorUrl(page), { timeout: 25_000 }).not.toBe('origin');
    expect(new URL(page.url()).searchParams.get('provider')).toBe('claude');
    // The earlier conversation stays with the assistant: the page holds its rows and the assistant's details list the Codex session it continued from.
    await holdsText(page, 'Original answer');
    await (await sessionsList(page)).locator('ol.lab-assistant-chain a[href*="session=origin"]').waitFor();
    await closeDetails(page);
    await send(page, 'Continue on Claude');
    await showsText(page, 'Echo: ');
    const first = claude.session(successorUrl(page)!)!.sent[0]!;
    expect(first).toContain('Original requirement');
    expect(first).toContain('Continue on Claude');
    expect(stack.provider.session('origin')?.sent ?? []).toEqual([]);
    await context.close();
  } finally { await stack.close(); }
});
