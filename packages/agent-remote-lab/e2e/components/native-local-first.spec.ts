// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test } from '@playwright/test';

// What a person sees while the workbench has not heard from its data yet, on desktop and on a phone: a quiet shell, never a sentence that says
// nothing is there, and a conversation never seen before opens with the shape of its layout.
const bot = '/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&pending=none';
const emptyWords = /No chats yet|Pick someone to talk to|No timeline activity|Nothing learned yet|No files changed/;

test('a roster nothing has answered keeps a quiet shell of the height of real rows and says nothing is missing', async ({ page }) => {
  await page.goto(bot + '&roster=unknown');
  const shell = page.locator('.lab-bot-quiet');
  await expect(shell).toBeVisible();
  await expect(shell.locator('.lab-bot-quiet-row')).toHaveCount(3);
  expect(await shell.locator('.lab-bot-quiet-row').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(56);
  await expect(page.locator('body')).not.toContainText(emptyWords);
  expect((await shell.textContent())?.trim()).toBe('');
});

test('the quiet shell holds the place of the rows that replace it', async ({ page }) => {
  await page.goto(bot + '&roster=unknown');
  const quietTop = await page.locator('.lab-bot-quiet-row').first().evaluate(node => Math.round(node.getBoundingClientRect().top));
  await page.goto(bot);
  const rowTop = await page.locator('.lab-bot-row:visible').first().evaluate(node => Math.round(node.getBoundingClientRect().top));
  expect(rowTop).toBe(quietTop);
});

test('a roster a load confirmed empty says so, and only then', async ({ page }) => {
  await page.goto(bot + '&roster=empty');
  await expect(page.locator('.lab-bot-empty')).toHaveText(/No chats yet/);
  await expect(page.locator('.lab-bot-quiet')).toHaveCount(0);
});

test('a row keeps its height when its sentence and marks are not there yet, so a late sentence moves nothing', async ({ page }) => {
  await page.goto(bot);
  const row = page.locator('.lab-bot-member').first();
  await expect(row.locator('.lab-bot-sentence')).toBeVisible();
  const withSentence = await row.evaluate(node => node.getBoundingClientRect().height);
  // The row as a roster with no status yet draws it: the same row without its sentence and its dots.
  const without = await row.evaluate(node => { node.querySelectorAll('.lab-bot-summary > *').forEach(part => part.remove()); return node.getBoundingClientRect().height; });
  expect(await row.locator('.lab-bot-summary').count()).toBe(1);
  expect(Math.abs(without - withSentence)).toBeLessThan(1);
});

test('before the roster loads, the conversation side shows no welcome sentence', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A phone shows one panel at a time; its roster is the first screen.');
  await page.goto(bot + '&roster=unknown');
  await expect(page.locator('.lab-bot-welcome[data-quiet]')).toBeVisible();
  await expect(page.locator('.lab-bot-conversation')).not.toContainText(emptyWords);
  await expect(page.locator('.lab-bot-conversation')).not.toContainText('Pick someone');
});

test('a conversation this device has not seen opens with the shape of its layout, never a blank body or an empty sentence', async ({ page }) => {
  await page.goto(bot + '&section=notes&bot=ghost');
  const pending = page.locator('.lab-bot-pending');
  await expect(pending).toBeVisible();
  await expect(pending.locator('.agent-timeline-skeleton-bubble')).toHaveCount(4);
  await expect(page.locator('body')).not.toContainText(emptyWords);
  expect(await pending.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(200);
});
