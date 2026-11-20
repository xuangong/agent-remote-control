import { expect, test, type Locator, type Page } from '@playwright/test';
import { ASSISTANT_INVENTORY } from '../fixtures/assistant-inventory.js';

// Every element the conversation showed before I3 is still reachable (I3 plan, section 5): one test per inventory row takes the
// row's path on the assistant-conversation fixture (open the work line, the step, the card, the receipt, the inspector) and finds
// the element by role or text. A row without a check fails. Rows of I3b open the details, the sidebar and the Window tiles.

async function open(page: Page, query = '') {
  const params = new URLSearchParams({ mode: 'concise', theme: 'light' });
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  await page.goto(`/e2e/fixtures/assistant-conversation.html?${params}`);
  await page.locator('.agent-turn').first().waitFor();
}
/** Presses a control the way a reader does after scrolling it into view; mobile WebKit does not scroll the fixture's nested
 *  conversation for a pointer click, and reaching the element is what each row checks. */
async function press(target: Locator) {
  await target.evaluate(node => { node.scrollIntoView({ block: 'center' }); (node as HTMLElement).click(); });
}
const entry = (page: Page, key: string) => page.locator(`.agent-timeline-entry[data-entry-key="${key}"]`);
const turnOf = (page: Page, key: string) => page.locator('.agent-turn', { has: page.locator(`[data-entry-key="${key}"]`) });
async function openWork(page: Page, key = 'prompt-1') {
  const line = turnOf(page, key).locator('.agent-work-line > button');
  if (await line.getAttribute('aria-expanded') !== 'true') await press(line);
  await expect(line).toHaveAttribute('aria-expanded', 'true');
}
async function openStep(page: Page, key: string) {
  const toggle = entry(page, key).locator('[aria-expanded]').first();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await press(toggle);
}
const requests = (page: Page) => page.locator('.agent-turn-requests');
/** Bot mode with Chief open and its details beside it (a sheet on a phone). */
async function openBot(page: Page, query = '') {
  await page.goto(`/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief&${query}`);
  await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
  const title = page.locator('.lab-assistant-top-bar button.lab-assistant-title');
  if (await title.getAttribute('aria-expanded') !== 'true') await press(title);
}
const details = (page: Page) => page.locator('.lab-assistant-details:visible, dialog.orchard-sheet[open]').first();
/** A Window of two tiles; the first one. */
async function openTile(page: Page) {
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=2');
  const close = page.locator('#lab-context').getByRole('button', { name: 'Close', exact: false }).first();
  if (await close.isVisible()) await close.click();
  const tile = page.locator('.lab-primary-group').first();
  await tile.locator('.lab-timeline-scroll').getByText('Item 1 of tile-1', { exact: false }).first().waitFor();
  return tile;
}
async function showChanges(card: Locator) {
  const toggle = card.locator('summary', { hasText: /Show what changes|看看要改什么/ });
  if (await toggle.count()) await press(toggle);
}

type Check = (page: Page) => Promise<void>;
const checks: Record<string, Check> = {
  M1: async page => {
    await open(page);
    const mine = entry(page, 'prompt-1').locator('.orchard-bubble-row[data-from="mine"]');
    await expect(mine).toContainText('Write notes.md with three IM design principles');
  },
  M2: async page => {
    await open(page);
    const bubble = entry(page, 'prompt-1').locator('.orchard-bubble');
    await expect(bubble).toContainText('brief.pdf');
    await expect(bubble.getByRole('button', { name: 'Preview Sketch' })).toBeVisible();
  },
  M3: async page => {
    await open(page);
    const bubble = entry(page, 'prompt-1').locator('.orchard-bubble');
    await expect(bubble.getByRole('list', { name: 'Quoted excerpts' })).toContainText('Earlier notes');
    await expect(bubble.getByLabel('Session references')).toContainText('Earlier notes');
  },
  M4: async page => {
    await open(page);
    const row = entry(page, 'withdrawn-1');
    await expect(row.getByRole('note')).toContainText('Not sent. The work was stopped before this message ran.');
    expect(await row.getByRole('note').evaluate(node => !node.closest('.orchard-bubble'))).toBe(true);
    await expect(row.getByRole('button', { name: 'Copy text' })).toBeVisible();
  },
  M5: async page => {
    await open(page);
    await expect(entry(page, 'answer-1').locator('.orchard-bubble-row[data-from="theirs"]')).toContainText('Done! I picked three');
  },
  M6: async page => {
    await open(page);
    await expect(entry(page, 'narration-1')).toHaveCount(0);
    await openWork(page);
    await expect(entry(page, 'narration-1')).toContainText('Let me check the existing notes first.');
  },
  M7: async page => {
    await open(page);
    await expect(page.locator('.orchard-bubble .agent-item-kicker')).toHaveCount(0);
    await expect(entry(page, 'prompt-1').locator('.orchard-bubble-row')).toHaveAttribute('data-from', 'mine');
    await openWork(page);
    await press(page.getByRole('button', { name: /Background checks/ }));
    await expect(entry(page, 'background-user').locator('.agent-item-kicker')).toContainText('Background check');
  },
  M8: async page => {
    await open(page);
    await expect(page.locator('.agent-day-separator').first()).toHaveAttribute('aria-label', /\d{2}:\d{2}/);
    const row = entry(page, 'prompt-1');
    if ((page.viewportSize()?.width ?? 0) > 1180) {
      await row.hover();
      await expect(row.locator('.agent-bubble-time')).toBeVisible();
      await expect(row.locator('.agent-bubble-time')).toHaveAttribute('datetime', /2026-11-20T10:57/);
    } else await expect(row.locator('.agent-entry-time time')).toHaveAttribute('datetime', /2026-11-20T10:57/);
  },
  M9: async page => {
    await open(page);
    const row = entry(page, 'prompt-1');
    await row.evaluate(node => node.scrollIntoView({ block: 'center' }));
    // The phone reveals the edit action with the swipe, so it is attached but hidden until then.
    await expect(row.locator('[data-prompt-edit-action][aria-label="Edit from this message"]').first()).toBeAttached();
    await expect(row.locator('[aria-label="Inspect event in Trace"]')).toBeAttached();
    await row.locator('[aria-label="Quote this message"]').dispatchEvent('click');
    await expect(row.getByRole('checkbox', { name: 'Select message' })).toHaveAttribute('aria-checked', 'true');
  },
  M10: async page => {
    await open(page);
    const letter = entry(page, 'letter-1').locator('.agent-communication-letter');
    await expect(letter).toContainText('Planner');
    await expect(letter).toContainText('Here are two examples you can use.');
  },
  R1: async page => {
    await open(page);
    await openWork(page);
    await openStep(page, 'reasoning-1');
    await expect(entry(page, 'reasoning-1').locator('.agent-reasoning-content')).toContainText('read what exists first');
  },
  T1: async page => {
    await open(page);
    await openWork(page);
    const header = entry(page, 'tool-shell').locator('.agent-tool-toggle');
    await expect(header).toContainText('Bash');
    await expect(header).toContainText('ls -la');
    await expect(header).toContainText('Completed');
    await expect(entry(page, 'tool-other')).toContainText('Researcher');
  },
  T2: async page => {
    await open(page, 'mode=full');
    await expect(entry(page, 'tool-shell').locator('.agent-tool-preview')).toContainText('ls -la');
    await expect(entry(page, 'tool-shell').locator('.agent-tool-preview')).toContainText('Exit code 0');
    await expect(entry(page, 'tool-failed').locator('.agent-tool-preview')).toContainText('lint: 2 problems');
  },
  T3: async page => {
    await open(page);
    await openWork(page);
    for (const key of ['tool-shell', 'tool-read', 'tool-search', 'tool-fetch', 'tool-other']) await openStep(page, key);
    await expect(entry(page, 'tool-shell').locator('.agent-tool-detail')).toContainText('/Users/me/notes');
    await expect(entry(page, 'tool-read').locator('.agent-tool-detail')).toContainText('/Users/me/notes/README.md');
    await expect(entry(page, 'tool-search').locator('.agent-tool-detail')).toContainText('principle');
    await expect(entry(page, 'tool-fetch').locator('.agent-tool-detail')).toContainText('https://example.com/im-design');
    await expect(entry(page, 'tool-other').locator('.agent-tool-detail')).toContainText('Ask Researcher for examples');
  },
  T4: async page => {
    await open(page);
    await openWork(page);
    for (const key of ['tool-shell', 'tool-read-2', 'tool-write', 'tool-failed']) await openStep(page, key);
    const result = entry(page, 'tool-shell').locator('.agent-tool-result');
    await expect(result).toContainText('Exit code 0');
    await expect(result).toContainText('12 ms');
    await expect(result).toContainText('stdout');
    await expect(entry(page, 'tool-read-2')).toContainText('Result truncated to fit the timeline.');
    await expect(entry(page, 'tool-write').getByText('Raw result')).toBeVisible();
    const failed = entry(page, 'tool-failed').locator('.agent-tool-result');
    await expect(failed).toContainText('stderr');
    await expect(failed).toContainText('lint: 2 problems');
    await expect(failed).toContainText('Exit code 1');
  },
  F1: async page => {
    await open(page);
    await openWork(page);
    await openStep(page, 'tool-edit');
    const change = entry(page, 'tool-edit').locator('.agent-file-change');
    await expect(change).toContainText('Renamed');
    await expect(change).toContainText('/Users/me/notes/OLD.md');
    await expect(change.getByLabel('1 added lines, 1 deleted lines')).toBeVisible();
    await expect(change.locator('.agent-diff-line-number').first()).toBeAttached();
  },
  D1: async page => {
    await open(page);
    await openWork(page);
    const todo = entry(page, 'todo-1');
    await expect(todo).toContainText('Read the notes');
    await expect(todo).toContainText('Completed');
    await expect(todo).toContainText('Pending');
    await open(page, 'pending=none');
    await expect(page.locator('.agent-turn-status')).toContainText('1 of 3 done');
  },
  C1: async page => {
    await open(page);
    await openWork(page);
    await expect(entry(page, 'compaction-1')).toContainText('Context compaction');
    await expect(entry(page, 'compaction-1')).toContainText('Trigger: auto');
  },
  E1: async page => {
    await open(page);
    await expect(turnOf(page, 'prompt-1').locator('.agent-work-line')).toContainText('2 steps failed');
    await openWork(page);
    const toggle = page.getByRole('button', { name: /Runtime notice/ });
    await expect(toggle).toContainText('2');
    await press(toggle);
    await expect(entry(page, 'notice-1')).toContainText('MCP server docs failed to start.');
    await expect(entry(page, 'notice-2')).toContainText('Retrying the docs server.');
  },
  B1: async page => {
    await open(page);
    await openWork(page);
    await expect(page.getByRole('button', { name: /Background checks/ })).toContainText('1');
  },
  I1: async page => {
    await open(page);
    const card = requests(page).locator('.agent-tool-approval').first();
    await expect(card.locator('.orchard-approval-prompt')).toHaveText('Chief wants to edit notes.md');
    await expect(card).toContainText('Edit · Allow Edit?');
    await showChanges(card);
    await expect(card).toContainText('/Users/me/notes/notes.md');
    await expect(card).toContainText('Add a short example');
  },
  I2: async page => {
    await open(page);
    const card = requests(page).locator('.agent-tool-approval').first();
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Not now', exact: true })).toBeVisible();
    await showChanges(card);
    for (const name of ['Allow once', 'Allow for session', 'Cancel', 'Deny']) await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    await press(card.locator('summary', { hasText: 'Rules for future requests' }));
    await expect(card.getByRole('button', { name: 'Apply rule' })).toBeVisible();
    await press(card.getByRole('button', { name: 'Allow', exact: true }));
    await expect(card.getByRole('status')).toHaveText('Submitting…');
  },
  I3: async page => {
    await open(page);
    const card = requests(page).locator('.agent-permission');
    await expect(card.locator('.orchard-approval-prompt')).toHaveText('Chief wants more access');
    await showChanges(card);
    await expect(card).toContainText('connect · network');
    await expect(card).toContainText('docs.example.com');
    await expect(card.getByRole('button', { name: 'Allow for session' })).toBeVisible();
  },
  I4: async page => {
    await open(page);
    const card = requests(page).locator('.agent-plan');
    await showChanges(card);
    await expect(card).toContainText('Add one example per principle');
    await expect(card.getByRole('textbox')).toBeVisible();
    for (const name of ['Approve', 'Approve and execute', 'Request revision']) await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  },
  I5: async page => {
    await open(page);
    const card = requests(page).locator('.agent-interaction-card', { has: page.locator('.agent-question') });
    await expect(card.locator('.agent-interaction-voice')).toHaveText('Chief has a question');
    await expect(card.getByRole('tab', { name: /Tone/ })).toBeVisible();
    await expect(card.getByText('Warm')).toBeVisible();
    await expect(card.getByRole('button', { name: /Submit/ })).toBeVisible();
    await expect(card.getByRole('button', { name: /Dismiss/ })).toBeVisible();
  },
  I6: async page => {
    await open(page);
    await expect(requests(page)).toContainText('Publishing details');
    await expect(requests(page).getByLabel(/Folder/)).toBeVisible();
    await expect(requests(page)).toContainText('Sign in to the docs site');
  },
  I7: async page => {
    await open(page);
    await expect(requests(page)).toContainText('Invalid interaction request');
    await open(page, 'status=connecting');
    await expect(requests(page).getByText('Waiting for connection to respond.').first()).toBeVisible();
    await open(page, 'respond=none');
    await expect(requests(page).getByText('Interaction unavailable').first()).toBeVisible();
  },
  I8: async page => {
    await open(page);
    const receipts: Array<[string, string]> = [['receipt-tool', 'Allowed once'], ['receipt-question', 'Answered'], ['receipt-plan', 'Plan approved'],
      ['receipt-form', 'Submitted'], ['receipt-permission', 'Allowed for this turn'], ['receipt-external', 'Done']];
    for (const [key, words] of receipts) await expect(entry(page, key).locator('.agent-receipt-toggle')).toContainText(words);
    await press(entry(page, 'receipt-tool').locator('.agent-receipt-toggle'));
    await expect(entry(page, 'receipt-tool').locator('.agent-receipt-details')).toContainText('/Users/me/notes/notes.md');
  },
  O1: async page => {
    await open(page);
    await expect(page.locator('[data-entry-key="outgoing-sending"]')).toContainText('Sending');
    const failed = page.locator('[data-entry-key="outgoing-failed"]');
    await expect(failed.getByRole('button', { name: 'Retry message' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Delete message' })).toBeVisible();
    await press(failed.getByRole('button', { name: 'Delivery error' }));
    await expect(failed).toContainText('The Host did not accept the message.');
  },
  O2: async page => {
    await open(page, 'status=connecting');
    const input = page.getByTestId('prompt-input');
    await input.click();
    await input.pressSequentially('Queued note');
    await page.getByTestId('prompt-submit').click();
    await expect(page.getByTestId('pending-send').first()).toBeVisible();
  },
  S1: async page => {
    await open(page, 'pending=none');
    const line = page.locator('.agent-turn-status');
    await expect(line.getByRole('status')).toHaveText('Chief is running tests');
    await expect(line).toContainText(/working · /);
    await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
    await expect(page.getByTestId('turn-elapsed')).toBeVisible();
    await expect(page.getByTestId('cancel-submit')).toBeVisible();
  },
  S2: async page => {
    await open(page, 'pending=none');
    await expect(page.locator('.agent-turn-status').getByRole('status')).toHaveText(/^Chief is /);
    expect(await page.locator('.agent-turn-status').evaluate(node => !!node.closest('.agent-turn'))).toBe(true);
  },
  H1: async page => {
    await open(page);
    await page.locator('summary', { hasText: 'Replica Inspector' }).click();
    const inspector = page.locator('.fixture-inspector');
    await expect(inspector).toContainText('agent-every-kind');
    await expect(inspector).toContainText('fixture');
  },
  H2: async page => {
    await open(page, 'older=1');
    const older = page.getByRole('button', { name: 'Load earlier activity' });
    await expect(older).toBeVisible();
    await press(older);
    await expect(page.getByRole('button', { name: 'Loading earlier activity…' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Earlier activity could not be loaded.' })).toBeVisible();
  },
  H3: async page => {
    await open(page);
    await expect(page.getByRole('separator', { name: 'Continued in a new session' })).toBeVisible();
    await expect(page.locator('.lab-earlier-session')).toContainText('Started notes.md with a title.');
    await press(page.getByRole('button', { name: 'Show earlier conversation' }));
    await expect(page.getByText('Loading earlier conversation…')).toBeVisible();
    await expect(page.getByText('Earlier conversation is unavailable.')).toBeVisible();
    await expect(page.locator('.lab-earlier-conversation').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('separator', { name: 'Continued in a new session' })).toHaveCount(2);
  },
  // I3b: the details panel, the sidebar, the top bar and the Window tiles.
  H4: async page => {
    await openBot(page, 'history=1');
    const sessions = details(page).locator('ol.lab-assistant-chain');
    // One compact row per session, newest first: its title, then its time and state.
    await expect(sessions.locator('li .lab-assistant-session-title')).toHaveText(['Chief', 'Earlier notes', 'Oldest notes']);
    // The session on screen says when its last turn was.
    await expect(sessions.locator('li .lab-assistant-session small')).toHaveText(['current', /.+ · earlier$/, 'earlier']);
    await expect(sessions.locator('li[aria-current] .lab-assistant-session-title')).toHaveText('Earlier notes');
    await expect(details(page).getByRole('link', { name: 'Return to current' })).toBeVisible();
  },
  H5: async page => {
    await openBot(page);
    await expect(details(page).getByRole('heading', { name: 'Subagent sessions' })).toBeVisible();
    await expect(details(page).getByRole('button', { name: 'Explore the notes folder', exact: true })).toBeVisible();
  },
  W1: async page => {
    const tile = await openTile(page);
    // The tile's one ⋯ menu holds its controls, the star among them on a wide screen; on a phone the star is in the details'
    // row of the session.
    await press(tile.getByRole('button', { name: 'More session actions' }));
    const menu = tile.locator('.lab-session-heading-actions-panel').first();
    if (!await menu.getByRole('button', { name: /^Star / }).count()) {
      await press(tile.getByRole('button', { name: 'More session actions' }));
      await press(tile.locator('button.lab-tile-who'));
      const sheet = page.locator('dialog.orchard-sheet[open]');
      await press(sheet.locator('ol.lab-assistant-chain .lab-assistant-session-toggle').first());
      await expect(sheet.getByRole('button', { name: /^Star / })).toBeVisible();
      await press(sheet.getByRole('button', { name: 'Close', exact: false }).first());
      await press(tile.getByRole('button', { name: 'More session actions' }));
    } else await expect(menu.getByRole('button', { name: /^Star / })).toBeVisible();
    for (const name of ['Back to previous conversation', 'Forward to next conversation', 'Share session link', 'Quote messages', 'Open in Bot mode']) await expect(menu.getByRole('button', { name })).toBeVisible();
    // Changing the tile's session: its menu on a wide screen, the navigation's Sessions on a phone.
    if (await menu.getByText('Sessions', { exact: false }).count()) await expect(menu.getByText('Sessions', { exact: false }).first()).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Open sessions', exact: true })).toBeVisible();
  },
  W2: async page => {
    const tile = await openTile(page);
    await press(tile.getByRole('button', { name: /^Details of / }));
    // Over the window on a wide screen, a sheet on a phone.
    const panel = page.locator('.lab-tile-details:visible, dialog.orchard-sheet[open]').first();
    const rows = Object.fromEntries(await panel.locator('.lab-assistant-row').evaluateAll(nodes => nodes.map(row => [row.firstElementChild?.textContent, row.lastElementChild?.textContent])));
    expect(rows).toMatchObject({ Agent: 'Recorded', Machine: 'Work Mac' });
    // The session's row opens to its ID.
    await press(panel.locator('.lab-assistant-chain .lab-assistant-session-toggle').first());
    await expect(panel.locator('.lab-assistant-identity')).toContainText('tile-1');
  },
  W3: async page => {
    await openBot(page);
    const rows = Object.fromEntries(await details(page).locator('.lab-assistant-row').evaluateAll(nodes => nodes.map(row => [row.firstElementChild?.textContent, row.lastElementChild?.textContent])));
    expect(rows).toMatchObject({ Agent: 'Claude Codebefore: Codex', Machine: 'Mac mini' });
    await expect(page.locator('.lab-bot-section-head h2')).toContainText('Notes');
  },
  W4: async page => {
    // The sidebar is the phone's home screen.
    await page.goto('/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes');
    await page.getByRole('navigation', { name: 'Assistants' }).waitFor();
    const row = (name: string) => page.getByRole('navigation', { name: 'Assistants' }).getByRole('button', { name, exact: true });
    await expect(row('Reviewer').locator('.lab-bot-role')).toHaveText('Side');
    await expect(row('Builder').locator('.lab-bot-label')).toHaveText('Tester');
    await expect(row('Reviewer').locator('.lab-bot-time')).toBeVisible();
    await expect(row('Reviewer').locator('.lab-bot-sentence')).toHaveText('Done reading, I have 3 thoughts');
    await expect(row('Reviewer').locator('.lab-bot-unread')).toBeVisible();
    await expect(row('Chief').getByLabel('Pinned')).toBeVisible();
    await expect(page.locator('[data-bot-asks="chief"]')).toContainText('Why the delay?');
  },
  W5: async page => {
    await openBot(page);
    await expect(page.locator('.lab-assistant-top-bar .lab-assistant-sentence')).toHaveText('Wants to ask you something');
  },
  W6: async page => {
    await openBot(page);
    const settings = details(page).locator('.lab-assistant-settings');
    await expect(settings.getByTestId('session-model-button')).toBeVisible();
    await expect(settings.getByTestId('session-permissions-button')).toBeVisible();
    await press(settings.getByRole('button', { name: 'Status' }));
    await expect(settings.getByRole('region', { name: 'Session status' })).toBeVisible();
    await expect(settings.getByLabel('Planning mode').first()).toBeVisible();
    // The composer keeps only the message.
    await expect(page.locator('.lab-bot-conversation .agent-composer').getByTestId('session-model-button')).toHaveCount(0);
  },
  W7: async page => {
    await open(page);
    await page.locator('summary', { hasText: 'Replica Inspector' }).click();
    const inspector = page.locator('.fixture-inspector');
    for (const words of ['Connection', 'Timeline synchronization', 'Pending live', 'Client diagnostics']) await expect(inspector).toContainText(words);
  },
};

test.describe('every element of the conversation is reachable', () => {
  for (const row of ASSISTANT_INVENTORY) {
    test(`${row.id}: ${row.before} → ${row.place} (${row.layer})`, async ({ page }) => {
      const check = checks[row.id];
      if (!check) throw new Error(`Inventory row ${row.id} has no check.`);
      await check(page);
    });
  }

  test('checks no row the inventory does not list', () => {
    expect(Object.keys(checks).filter(id => !ASSISTANT_INVENTORY.some(row => row.id === id))).toEqual([]);
  });
});

test.describe('in Chinese', () => {
  // A Chinese reader's fixture: Chinese sample data too, its assistant named 团团.
  test.use({ locale: 'zh-CN' });

  test('the conversation speaks in the design voice', async ({ page }) => {
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const card = requests(page).locator('.agent-tool-approval').first();
    await expect(card.locator('.orchard-approval-prompt')).toHaveText('团团 想改一下 notes.md，可以吗？');
    for (const name of ['好的', '先别']) await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(card.locator('summary', { hasText: '看看要改什么' })).toBeVisible();
    await expect(turnOf(page, 'prompt-1').locator('.agent-work-line')).toContainText('2 步没成功');
    await expect(entry(page, 'receipt-tool').locator('.agent-receipt-toggle')).toContainText('允许了这一次');
    await expect(page.getByRole('separator', { name: '换到新的会话继续' })).toBeVisible();
    await expect(page.locator('.agent-day-separator').first()).toHaveAttribute('aria-label', /今天|昨天|月/);
  });

  test('the live line says what the assistant is doing', async ({ page }) => {
    await open(page, 'pending=none');
    await expect(page.locator('.agent-turn-status').getByRole('status')).toHaveText('团团 在跑测试，稍等～');
    await expect(page.locator('.agent-turn-status')).toContainText('认真工作中');
    await expect(page.locator('.agent-turn-status')).toContainText('完成 1/3');
  });
});
