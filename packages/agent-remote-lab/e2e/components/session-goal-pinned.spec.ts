import { expect, test, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';

// The goal a session works toward stays visible as one pinned line above its conversation, in any state, at desktop and phone width: it keeps
// its height (a long objective is cut, never wrapped), it keeps clear of the team page line pinned with it, a rewrite of the goal or a
// press of Pause, Resume or Clear moves no entry, and its actions send the command its adapter named.
const OPEN = '/e2e/fixtures/assistant-conversation.html?pending=none&mode=concise';
const scrollerOf = (page: Page) => page.locator('.agent-timeline-entries').last().evaluateHandle(node => { let at: HTMLElement | null = node as HTMLElement;
  while (at && !(['auto', 'scroll'].includes(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight)) at = at.parentElement; return at!; });
// How far the last entry stands above the foot of the conversation's scroll area, which a reader at the end of the conversation keeps in view.
const lastEntryTop = (page: Page) => page.locator('.agent-timeline-entries').last().evaluate(node => { let at: HTMLElement | null = node as HTMLElement;
  while (at && !(['auto', 'scroll'].includes(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight)) at = at.parentElement;
  return (node.lastElementChild as HTMLElement).getBoundingClientRect().bottom - at!.getBoundingClientRect().bottom; });
const settled = (page: Page) => expect.poll(async () => { const first = await lastEntryTop(page); await page.waitForTimeout(150); return first === await lastEntryTop(page); }).toBe(true);
const line = (page: Page) => page.locator('[data-goal-line]');
const goalCommands = (page: Page) => page.evaluate(() => (window as unknown as { goalCommands: Array<[string, string]> }).goalCommands);

test('pins the goal in a long conversation read at its end, and shifts nothing as it changes', async ({ page }) => {
  await page.goto(`${OPEN}&goal=active`);
  await expect(line(page)).toHaveCount(1);
  const holder = await scrollerOf(page);
  expect(await holder.evaluate(node => (node as HTMLElement).scrollHeight - (node as HTMLElement).clientHeight)).toBeGreaterThan(600);
  const inView = () => Promise.all([line(page).boundingBox(), holder.evaluate(node => (node as HTMLElement).getBoundingClientRect().top)]).then(([box, top]) => !!box && box.y >= top - 1 && box.y <= top + 80);
  await expect.poll(inView).toBe(true);
  await settled(page);
  const before = await lastEntryTop(page);
  const height = (await line(page).boundingBox())!.height;
  await expect(line(page)).toContainText('Working toward it · 3 checks · 12k tokens · 4m 05s');
  // The CLI reports another check, then its end.
  await page.evaluate(() => (window as unknown as { setGoal(patch: object): void }).setGoal({ iterations: 4, lastReason: 'One test still fails' }));
  await expect(line(page)).toContainText('4 checks');
  expect(await lastEntryTop(page)).toBe(before);
  await page.evaluate(() => (window as unknown as { setGoal(patch: object): void }).setGoal({ status: 'complete' }));
  await expect(line(page)).toContainText('Done');
  await expect(line(page).locator('button')).toHaveCount(0);
  expect(await lastEntryTop(page)).toBe(before);
  expect((await line(page).boundingBox())!.height).toBe(height);
  expect(await inView()).toBe(true);
});

test('Pause, Resume and Clear goal send the adapter\'s commands, and the line follows without moving an entry', async ({ page }) => {
  await page.goto(`${OPEN}&goal=active`);
  await expect(line(page)).toHaveCount(1);
  await settled(page);
  const before = await lastEntryTop(page);
  await line(page).getByRole('button', { name: 'Pause' }).dispatchEvent('click');
  await expect(line(page)).toContainText('Paused');
  await expect(line(page).getByRole('button', { name: 'Resume' })).toBeVisible();
  expect(await lastEntryTop(page)).toBe(before);
  await line(page).getByRole('button', { name: 'Resume' }).dispatchEvent('click');
  await expect(line(page)).toContainText('Working toward it');
  await line(page).getByRole('button', { name: 'Clear goal' }).dispatchEvent('click');
  await expect(line(page)).toHaveCount(0);
  expect(await goalCommands(page)).toEqual([['goal', 'pause'], ['goal', 'resume'], ['goal', 'clear']]);
  // Removing the line leaves the reader where they were: the entries keep their place at the foot of the conversation.
  expect(await lastEntryTop(page)).toBe(before);
});

for (const state of ['active', 'paused', 'complete', 'long'] as const) {
  test(`the ${state} goal fills one line of one height, inside the page's width`, async ({ page }) => {
    await page.goto(`${OPEN}&goal=${state}`);
    await expect(line(page)).toHaveCount(1);
    const box = (await line(page).boundingBox())!;
    expect(box.height).toBe(36);
    const fits = await line(page).evaluate(node => ({ line: node.scrollWidth <= node.clientWidth + 1, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      objective: (node.querySelector('.agent-goal-objective') as HTMLElement).getBoundingClientRect().width }));
    expect(fits).toMatchObject({ line: true, page: true });
    expect(fits.objective).toBeGreaterThan(60);
    for (const button of await line(page).locator('button').all()) {
      const buttonBox = (await button.boundingBox())!;
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(buttonBox.x).toBeGreaterThanOrEqual(box.x);
    }
  });
}

test('keeps clear of the team page line pinned with it', async ({ page }) => {
  await page.goto(`${OPEN}&goal=active&pages=1`);
  const card = page.locator('[data-page-card]').first();
  await expect(card).toHaveCount(1);
  const holder = await scrollerOf(page);
  await expect.poll(async () => { const [goal, pageBox, top] = await Promise.all([line(page).boundingBox(), card.boundingBox(), holder.evaluate(node => (node as HTMLElement).getBoundingClientRect().top)]);
    return !!goal && !!pageBox && goal.y >= top - 1 && goal.y <= top + 12 && pageBox.y >= goal.y + goal.height - 1 && pageBox.y <= goal.y + goal.height + 4; }).toBe(true);
  await settled(page);
  const before = await lastEntryTop(page);
  await card.getByRole('button', { name: 'Show page' }).dispatchEvent('click');
  await expect(card.locator('table')).toBeVisible();
  expect(await lastEntryTop(page)).toBe(before);
});

test('every word of the line passes contrast in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.goto(`${OPEN}&goal=active&theme=${theme}`);
    await expect(line(page)).toHaveCount(1);
    expect((await contrastFailures(page)).filter(failure => JSON.stringify(failure).includes('agent-goal'))).toEqual([]);
  }
});

test.describe('in Chinese', () => {
  test.use({ locale: 'zh-CN' });
  test('says the goal in Chinese', async ({ page }) => {
    await page.goto(`${OPEN}&goal=paused`);
    await expect(line(page)).toContainText('目标');
    await expect(line(page)).toContainText('已暂停');
    await expect(line(page).getByRole('button', { name: '继续' })).toBeVisible();
    await expect(line(page).getByRole('button', { name: '清除目标' })).toBeVisible();
  });
});
