// E1 of the target architecture: pair a Controller with a key the page generated, see its Host online, open a session from the directory
// and read it (messages, tool calls, reasoning, markdown), and open Trace on the same session; and start a new session in a folder
// made from Browse.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recording as claudeRecording } from '@orchardworks/agent-provider-claude/recordings';
import { recordedHistory, startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, rowTexts } from './browser.js';
import { chooseProcessMode, openAllSessions, openSettings, send, showSidebar, showTrace, showsText, timelineEntries, waitForEntries } from './page.js';

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
  await openSettings(page, 'Computers');
  await page.getByRole('button', { name: 'Pair a computer', exact: true }).click();
  await page.getByRole('button', { name: 'Generate pairing key', exact: true }).click();
  const configuration = await page.getByLabel('Agent Host configuration').inputValue();
  const key = /AGENT_HOST_REMOTE_KEY='([^']+)'/.exec(configuration)?.[1];
  expect(key).toBeTruthy();
  const paired = await stack.pairController({ key: key!, name: 'Second Host', installationId: 'e2e-second', sessions: { second: { title: 'On the second Host', history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hi from the second Host' }] } } });
  try {
    await showsText(page, '2 computers online');
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

it('E1: a new session starts in a folder made from Browse and answers its first message', async () => {
  // Its own stack: an execution policy that allows the folder makes the Controller check the workspace of every session it lists.
  const folders = await startStack({ providerId: 'claude', displayName: 'Claude Code', workspaces: true });
  try {
    const { context, page } = await openPage(browser, folders.origin + '/');
    const rail = await showSidebar(page);
    await rail.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menu', { name: 'New', exact: true }).getByRole('menuitem', { name: 'New session', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(folders.hostId);
    await page.getByTestId('provider-select').selectOption(JSON.stringify([folders.hostId, 'claude']));
    await page.getByRole('button', { name: 'Browse…' }).click();
    const picker = page.getByRole('dialog', { name: 'Choose a workspace folder' });
    await expect.poll(() => picker.getByLabel('Folder path').inputValue()).toBe(folders.workspace);
    await picker.getByRole('button', { name: 'New folder', exact: true }).click();
    await picker.getByLabel('New folder name').fill('Fresh project');
    await picker.getByRole('button', { name: 'Create folder', exact: true }).click();
    const folder = join(folders.workspace, 'Fresh project');
    await expect.poll(() => picker.getByLabel('Folder path').inputValue()).toBe(folder);
    expect((await stat(folder)).isDirectory()).toBe(true);
    await picker.getByRole('button', { name: 'Select folder' }).click();
    await expect.poll(() => page.getByLabel('Working directory', { exact: true }).inputValue()).toBe(folder);
    await page.getByTestId('session-create').click();
    await page.getByTestId('prompt-input').waitFor();
    await expect.poll(() => page.getByTestId('prompt-input').isEnabled()).toBe(true);
    const started = folders.provider.known().find(id => id.startsWith('claude-new-'))!;
    expect(folders.provider.startedIn(started)).toBe(folder);
    await send(page, 'Hello from the new folder');
    await showsText(page, 'Echo: Hello from the new folder');
    await context.close();
  } finally { await folders.close(); }
});
