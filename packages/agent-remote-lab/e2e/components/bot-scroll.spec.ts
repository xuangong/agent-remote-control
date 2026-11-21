// Component projects: webkit-conversation
import { expect, test } from '@playwright/test';

// Bot mode on a wide screen: a long assistant name stays inside its row, and the list and the conversation scroll on their own.
const url = '/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief&assistants=40&longName=1&pending=none';

test('a long name stays in the list, and the list and the conversation scroll independently', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The two panels show together on wide screens; the phone shows one at a time.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const roster = page.locator('.lab-bot-roster'), timeline = page.locator('.lab-bot-conversation .lab-timeline-scroll').first();
  await expect(timeline).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.lab-bot-roster').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await roster.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  const before = await timeline.evaluate(node => node.scrollTop);
  await roster.hover(); await page.mouse.wheel(0, 500);
  await expect.poll(() => roster.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  expect(await timeline.evaluate(node => node.scrollTop)).toBe(before);
  const rosterAt = await roster.evaluate(node => node.scrollTop);
  await timeline.hover(); await page.mouse.wheel(0, -500);
  await expect.poll(() => timeline.evaluate(node => node.scrollTop)).not.toBe(before);
  expect(await roster.evaluate(node => node.scrollTop)).toBe(rosterAt);
});
