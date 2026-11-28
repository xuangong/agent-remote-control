// Component projects: webkit-desktop
import { expect, test, type Page } from '@playwright/test';

// The bot workbench's rail at desktop width: the main tile and the person's own tile first, then the bot's sub-sessions as folded strips in the
// order needs-you, working, idle; nothing expands by itself; a sub-session that starts or ends changes the strips and never moves the tile the
// person is using; expanding is this device's own state; and the Window is never written for what the bot does.
type Workbench = { writes: unknown[]; set(teams: unknown[]): void };
const state = (n: number, state: string, step?: string) => ({ id: `s${n}`, status: 'active', source: { nativeSessionId: 'main' },
  task: { title: `Sub-session ${n}`, state, subSessionId: `s_${n}`, createdAt: n, updatedAt: n, ...(step ? { currentStep: step } : {}) },
  members: [{ id: `n${n}`, hostId: 'fixture', providerId: 'recorded', role: 'leader', name: `n${n}`, nativeSessionId: `n${n}`, creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 },
    { id: 'main', hostId: 'fixture', providerId: 'recorded', role: 'requester', name: 'main', nativeSessionId: 'main', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }] });
const open = async (page: Page, query = '') => { await page.goto(`/e2e/fixtures/bot-workbench.html${query}`); await expect(page.locator('[data-primary-group-id="main"]')).toBeVisible(); };
const strips = (page: Page) => page.locator('[data-primary-group-id^="sub:"]');
const box = async (page: Page, id: string) => (await page.locator(`[data-primary-group-id="${id}"]`).boundingBox())!;
const setTeams = (page: Page, teams: unknown[]) => page.evaluate(next => (window as unknown as { workbench: Workbench }).workbench.set(next), teams);

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'The desktop rail; the phone shows a list.'));

test('shows the main tile and the person\'s tile first, then the sub-sessions as folded strips ordered by need', async ({ page }, testInfo) => {
  await open(page, '?subs=5');
  const ids = await page.locator('[data-primary-group-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-primary-group-id')));
  expect(ids).toEqual(['main', 'note', 'sub:s1', 'sub:s2', 'sub:s4', 'sub:s3', 'group:ended']);
  for (const id of ids.slice(2)) await expect(page.locator(`[data-primary-group-id="${id}"]`)).toHaveAttribute('data-minimized', 'true');
  await expect(page.locator('[data-primary-group-id="sub:s5"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('workbench-strips.png') });
});

test('a sub-session that starts or ends changes the strips without moving the tile in use and without writing the Window', async ({ page }) => {
  await open(page, '?subs=2');
  await page.getByLabel('Draft for My notes').fill('typing here');
  const before = await box(page, 'note');
  await setTeams(page, [state(1, 'working'), state(2, 'idle'), state(3, 'needs_input'), state(4, 'working')]);
  await expect(strips(page)).toHaveCount(4);
  const after = await box(page, 'note');
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  await expect(page.getByLabel('Draft for My notes')).toHaveValue('typing here');
  await setTeams(page, [state(1, 'ended'), state(2, 'idle'), state(3, 'needs_input'), state(4, 'working')]);
  await expect(strips(page)).toHaveCount(3);
  expect(await page.evaluate(() => (window as unknown as { workbench: Workbench }).workbench.writes)).toEqual([]);
});

test('keeps an expanded tile in its place when a sub-session that needs the person arrives before it', async ({ page }) => {
  await open(page, '?subs=3');
  await page.locator('[data-primary-group-id="sub:s3"] button.lab-folded-bot').click();
  const tile = page.locator('[data-primary-group-id="sub:s3"]');
  await expect(tile.locator('.lab-derived-tile')).toBeVisible();
  const before = await box(page, 'sub:s3');
  await setTeams(page, [state(1, 'needs_input'), state(2, 'working'), state(3, 'idle'), state(4, 'needs_input')]);
  await expect(strips(page)).toHaveCount(4);
  const after = await box(page, 'sub:s3');
  expect(Math.abs(after.x - before.x), 'the selected tile stays where it was').toBeLessThan(1);
  const order = await strips(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-primary-group-id')));
  expect(order).toEqual(['sub:s1', 'sub:s4', 'sub:s3', 'sub:s2']);
});

test('never expands a tile by itself and expands one when the person asks', async ({ page }) => {
  await open(page, '?subs=2');
  await setTeams(page, [state(1, 'needs_input', 'Waiting for approval'), state(2, 'working')]);
  await expect(page.locator('.lab-derived-tile')).toHaveCount(0);
  await page.locator('[data-primary-group-id="sub:s2"] button.lab-folded-bot').click();
  await expect(page.locator('.lab-derived-tile')).toHaveCount(1);
  await expect(page.locator('.lab-derived-tile-state')).toHaveText('Working');
});

test('folds ended sub-sessions into one strip whose rows open as tiles and return to it when the person leaves', async ({ page }) => {
  await open(page, '?subs=5');
  await page.locator('[data-primary-group-id="group:ended"] button.lab-folded-bot').click();
  await page.getByRole('button', { name: /Sub-session 5/ }).click();
  const tile = page.locator('[data-primary-group-id="sub:s5"] .lab-derived-tile');
  await expect(tile).toBeVisible();
  await expect(tile.locator('.lab-derived-tile-state')).toHaveText('Ended');
  await page.getByLabel('Draft for My notes').click();
  await expect(page.locator('[data-primary-group-id="sub:s5"]')).toHaveCount(0);
});
