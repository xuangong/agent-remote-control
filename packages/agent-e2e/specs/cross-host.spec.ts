import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { crossHostFixture } from './cross-host-fixture';

// Stage 7: the workbench across Hosts, end to end — the real hosted Relay, two real Controller runtimes and the built Lab.
// Native sessions answer "<Host>/<provider>: <message>"; nothing runs a model.
const studio = { name: 'Studio', providers: [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude' }],
  sessions: [{ providerId: 'codex', nativeSessionId: 'studio-codex', title: 'Studio task', history: ['Plan the release', 'The release plan is ready.'] }] };
const laptop = { name: 'Laptop', providers: [{ providerId: 'claude', displayName: 'Claude' }],
  sessions: [{ providerId: 'claude', nativeSessionId: 'laptop-claude', title: 'Laptop task', history: ['Review the notes', 'The notes look good.'] }] };

// Two Controllers, two devices and a Handoff take longer than one page.
test.describe.configure({ timeout: 120_000 });
type Fixture = Awaited<ReturnType<typeof crossHostFixture>>;
const bots = (page: Page) => page.locator('[data-workbench-mode="bot"]').getByRole('navigation', { name: 'Assistants', exact: true });
const conversation = (page: Page) => page.locator('[data-workbench-mode="bot"]').getByRole('region', { name: 'Bot conversation', exact: true });
const composer = (page: Page) => page.locator('[data-workbench-mode="bot"]').getByTestId('prompt-input').locator('visible=true');
const row = (page: Page, name: string) => bots(page).getByRole('button', { name, exact: true });

/** A group holding one bot on each Host. */
async function releaseGroup(fixture: Fixture, context: BrowserContext) {
  await fixture.seed(context);
  const id = fixture.newOperationId();
  await fixture.windows(context).create({ schemaVersion: 3, id, revision: 0, title: 'Release', selectedViewId: 'S1', selectedPrimaryViewId: 'S1', views: [
    createWindowView('S1', { hostId: fixture.host('Studio').hostId, providerId: 'codex', nativeSessionId: 'studio-codex', title: 'Studio task' }, 'primary'),
    createWindowView('L1', { hostId: fixture.host('Laptop').hostId, providerId: 'claude', nativeSessionId: 'laptop-claude', title: 'Laptop task' }, 'primary')] });
  return id;
}
async function openBots(page: Page, fixture: Fixture) {
  await page.goto(`${fixture.origin}/?mode=bot`);
  await expect(row(page, 'Studio task')).toBeVisible({ timeout: 20_000 });
  await expect(row(page, 'Laptop task')).toBeVisible();
}
/** A phone shows the list or a chat: back to the list, where the rows are. */
async function showList(page: Page) {
  const back = page.locator('[data-workbench-mode="bot"]').getByRole('button', { name: 'Back to assistants', exact: true });
  // A page that is still loading shows neither yet.
  await expect.poll(async () => await back.isVisible() || await bots(page).isVisible(), { timeout: 20_000 }).toBe(true);
  if (await back.isVisible()) await back.click();
}
async function open(page: Page, name: string) {
  await showList(page);
  await row(page, name).click();
  await expect(conversation(page).getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled({ timeout: 20_000 });
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(page.locator('[data-workbench-mode="bot"]').getByTestId('prompt-submit')).toBeEnabled();
  await composer(page).press('Enter');
}
async function info(page: Page): Promise<string> {
  await conversation(page).getByRole('button', { name: /^Bot actions: / }).click();
  await page.getByRole('menuitem', { name: 'Info', exact: true }).click();
  const sheet = page.getByRole('dialog').last();
  const text = await sheet.innerText();
  await page.keyboard.press('Escape');
  return text;
}
const replies = (page: Page) => conversation(page).locator('.agent-message-assistant');
async function expectReply(page: Page, text: string) { await expect(replies(page).filter({ hasText: text })).toHaveCount(1, { timeout: 20_000 }); }
const preview = (page: Page, name: string): Locator => row(page, name).locator('.lab-bot-sentence');

let fixture: Fixture;
test.beforeEach(async () => { fixture = await crossHostFixture([studio, laptop]); });
test.afterEach(async () => { await fixture?.close(); });

test('works with bots on two Hosts in one group: each send reaches its own Host, and replies and drafts stay apart', async ({ page, context }) => {
  await releaseGroup(fixture, context);
  await openBots(page, fixture);
  await open(page, 'Studio task');
  expect(await info(page)).toMatch(/Studio[\s\S]*Codex/);
  await send(page, 'Ship the release');
  await expectReply(page, 'Studio/codex: Ship the release');
  await open(page, 'Laptop task');
  expect(await info(page)).toMatch(/Laptop[\s\S]*Claude/);
  await send(page, 'Check the notes');
  await expectReply(page, 'Laptop/claude: Check the notes');
  expect(fixture.host('Studio').native('codex', 'studio-codex')!.received).toEqual(['Ship the release']);
  expect(fixture.host('Laptop').native('claude', 'laptop-claude')!.received).toEqual(['Check the notes']);
  // Each row carries its own bot's latest reply.
  await showList(page);
  await expect(preview(page, 'Studio task')).toContainText('Studio/codex: Ship the release', { timeout: 20_000 });
  await expect(preview(page, 'Laptop task')).toContainText('Laptop/claude: Check the notes', { timeout: 20_000 });
  // Drafts stay with their bot.
  await open(page, 'Studio task');
  await composer(page).fill('A Studio draft');
  await open(page, 'Laptop task');
  await expect(composer(page)).toHaveText('');
  await open(page, 'Studio task');
  await expect(composer(page)).toHaveText('A Studio draft');
  await expect(replies(page).filter({ hasText: 'Laptop/claude' })).toHaveCount(0);
});

test('keeps a message for an offline Host on every device, cancels it everywhere and delivers the next one once on return', async ({ browser, context, page }) => {
  // This project's device, and a second one beside it.
  const desk = await browser.newContext();
  try {
    await releaseGroup(fixture, context); await fixture.seed(desk);
    const other = await desk.newPage();
    for (const each of [page, other]) { await openBots(each, fixture); await open(each, 'Laptop task'); }
    await fixture.host('Laptop').disconnect();
    const submit = page.locator('[data-workbench-mode="bot"]').getByTestId('prompt-submit');
    await composer(page).fill('Queued while away');
    await expect(submit).toHaveAccessibleName('Send when Laptop is back', { timeout: 30_000 });
    await composer(page).press('Enter');
    const waiting = (target: Page, text: string) => conversation(target).locator('.lab-outbox-message').filter({ hasText: text });
    for (const each of [page, other]) await expect(waiting(each, 'Queued while away')).toContainText('Waiting for Laptop', { timeout: 20_000 });
    // Cancelled on one device, it is gone on both and never sent.
    await waiting(other, 'Queued while away').getByRole('button', { name: 'Cancel message', exact: true }).click();
    for (const each of [page, other]) await expect(waiting(each, 'Queued while away')).toHaveCount(0, { timeout: 20_000 });
    await composer(page).fill('Delivered on return'); await composer(page).press('Enter');
    for (const each of [page, other]) await expect(waiting(each, 'Delivered on return')).toHaveCount(1, { timeout: 20_000 });
    // The other Host keeps working meanwhile.
    await open(other, 'Studio task');
    await send(other, 'Still here');
    await expectReply(other, 'Studio/codex: Still here');
    await fixture.host('Laptop').reconnect();
    await expectReply(page, 'Laptop/claude: Delivered on return');
    await expect(waiting(page, 'Delivered on return')).toHaveCount(0);
    expect(fixture.host('Laptop').native('claude', 'laptop-claude')!.received).toEqual(['Delivered on return']);
    // A reload delivers nothing again.
    await page.reload(); await open(page, 'Laptop task');
    await expectReply(page, 'Laptop/claude: Delivered on return');
    expect(fixture.host('Laptop').native('claude', 'laptop-claude')!.received).toEqual(['Delivered on return']);
  } finally { await desk.close(); }
});

test('hands a bot off to another provider on its Host and keeps its place, conversation and earlier provider', async ({ browser, page, context }) => {
  const groupId = await releaseGroup(fixture, context);
  await openBots(page, fixture);
  await open(page, 'Studio task');
  await send(page, 'First on Codex');
  await expectReply(page, 'Studio/codex: First on Codex');
  const bot = page.locator('[data-workbench-mode="bot"]');
  await bot.getByRole('button', { name: 'Open chat commands', exact: true }).click();
  await bot.getByRole('option', { name: /^\/handoff/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand off conversation', exact: true });
  await dialog.getByRole('combobox', { name: 'Successor provider', exact: true }).selectOption('claude');
  await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
  // The bot keeps its view in its group; the view now holds the Claude session.
  const windows = fixture.windows(context);
  await expect.poll(async () => (await windows.inspect(groupId)).window.views.find(view => view.id === 'S1')?.binding?.providerId, { timeout: 30_000 }).toBe('claude');
  await expect(bot.locator('.lab-handoff-notice')).toHaveCount(0, { timeout: 30_000 });
  await showList(page);
  await expect(row(page, 'Studio task')).toHaveCount(1);
  await open(page, 'Studio task');
  // Its earlier conversation stays readable above the new one.
  await expect(conversation(page).getByText('Studio/codex: First on Codex')).toBeVisible();
  // Another device, which did not compose this group, still sees the bot's row go on with its latest reply: it learns
  // the bot's chain from the Relay's succession records.
  const elsewhere = await browser.newContext();
  try {
    await fixture.seed(elsewhere);
    const other = await elsewhere.newPage();
    await openBots(other, fixture);
    await expect(preview(other, 'Studio task')).toContainText('Studio/codex: First on Codex', { timeout: 20_000 });
  } finally { await elsewhere.close(); }
  await send(page, 'Continue on Claude');
  await expectReply(page, 'Studio/claude: Continue on Claude');
  const successor = (await windows.inspect(groupId)).window.views.find(view => view.id === 'S1')!.binding!;
  expect(fixture.host('Studio').native('claude', successor.nativeSessionId)!.received.at(-1)).toContain('Continue on Claude');
  expect(fixture.host('Studio').native('codex', 'studio-codex')!.received).toEqual(['First on Codex']);
  expect(await info(page)).toMatch(/Claude[\s\S]*Codex/);
});
