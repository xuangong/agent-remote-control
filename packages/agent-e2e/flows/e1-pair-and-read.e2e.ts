// E1 of the target architecture: pair a Controller with a key the page generated, see its Host online, open a session from the directory
// and read it (messages, tool calls, reasoning, markdown), and open Trace on the same session.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recording as claudeRecording } from '@orchardworks/agent-provider-claude/recordings';
import { recordedHistory, startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, rowTexts } from './browser.js';
import { chooseProcessMode, openAllSessions, openSettings, showTrace, showsText, timelineEntries, waitForEntries } from './page.js';

const markdown = '## Summary\n\n- **bold** item\n- `code` item\n\n```ts\nconst answer = 42;\n```';
let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({
    providerId: 'claude', displayName: 'Claude Code',
    sessions: {
      // The rows of a real Claude run (tool calls included) followed by one constructed reply that holds markdown.
      tools: { title: 'Recorded tools', history: [...recordedHistory(claudeRecording('settled')), { role: 'assistant', text: markdown }] },
      thinking: { title: 'Recorded thinking', history: recordedHistory(claudeRecording('thinking')) },
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E1: a key generated in the page pairs a second Controller, and its Host shows online', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/');
  await openSettings(page);
  await page.getByRole('button', { name: 'Pair Agent Host', exact: true }).click();
  await page.getByRole('button', { name: 'Generate pairing key', exact: true }).click();
  const configuration = await page.getByLabel('Agent Host configuration').inputValue();
  const key = /AGENT_HOST_REMOTE_KEY='([^']+)'/.exec(configuration)?.[1];
  expect(key).toBeTruthy();
  const paired = await stack.pairController({ key: key!, name: 'Second Host', installationId: 'e2e-second', sessions: { second: { title: 'On the second Host', history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hi from the second Host' }] } } });
  try {
    await showsText(page, '2 Hosts online');
    await page.goto(paired.sessionUrl('second'), { waitUntil: 'domcontentloaded' });
    await showsText(page, 'Hi from the second Host');
  } finally { await paired.close(); }
  await context.close();
});

it('E1: the directory lists the Host and its session, and opening the session shows its rows', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/');
  await openAllSessions(page);
  await page.getByLabel('Connected Host').selectOption({ index: 1 });
  await showsText(page, 'Recorded tools');
  await page.getByText('Recorded tools', { exact: false }).first().click();
  await waitForEntries(page, 3);
  expect((await rowTexts(page)).some(text => text.includes('SECOND_PROMPT'))).toBe(true);
  await context.close();
});

it('E1: messages, tool calls and markdown of a recorded Claude run read as a conversation', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('tools'));
  // Full shows every step of each turn's work, as the preview display did; Concise folds them into the work line.
  await page.locator('.agent-turn').first().waitFor();
  await chooseProcessMode(page, 'Full');
  await waitForEntries(page, 9);
  const rows = await rowTexts(page);
  expect(rows.filter(text => /▸(Write|Edit|Bash)/.test(text))).toHaveLength(3);
  expect(rows.some(text => text.includes('ANSWER_1'))).toBe(true);
  expect(await page.locator('.agent-message-assistant h2', { hasText: 'Summary' }).count()).toBe(1);
  expect(await page.locator('.agent-message-assistant li strong', { hasText: 'bold' }).count()).toBe(1);
  expect(await page.locator('.agent-message-assistant pre', { hasText: 'const answer = 42;' }).count()).toBe(1);
  await context.close();
});

it('E1: reasoning reads in the conversation and Trace lists the same events', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('thinking'));
  await page.locator('.agent-turn').first().waitFor();
  await chooseProcessMode(page, 'Full');
  await waitForEntries(page, 3);
  expect(await timelineEntries(page).filter({ hasText: 'Let me think about it.' }).count()).toBe(1);
  await showTrace(page);
  await showsText(page, 'Reasoning update');
  await showsText(page, '3 / 3 loaded');
  await context.close();
});
