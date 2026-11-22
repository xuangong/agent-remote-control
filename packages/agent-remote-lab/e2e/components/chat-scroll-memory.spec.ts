// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// Scroll memory (I5d): each chat opens again where the reader left it, after another chat was open and after a reload; a chat the
// reader left at its latest message opens at its latest message. Bot mode over the real Workbench on builder data.
const url = '/e2e/fixtures/window-tiles.html?tiles=3&bots=1&mode=bot&users=4';

async function chats(page: Page) {
  const phone = (page.viewportSize()?.width ?? 1440) <= 760;
  const bot = page.locator('[data-workbench-mode="bot"]');
  const scroller = bot.locator('.lab-timeline-scroll:visible');
  const open = async (index: number) => {
    if (phone && await scroller.count()) await bot.getByRole('button', { name: 'Back to chats' }).first().click();
    await bot.locator('[data-bot-place]').nth(index).click();
    await expect(scroller).toHaveCount(1);
    await expect(scroller.locator('[data-entry-key]').first()).toBeVisible();
  };
  // The row at the top of the conversation and its distance from the top: the place the reader sees.
  const place = () => scroller.evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.getBoundingClientRect().bottom > top + 1);
    return { key: row?.dataset.entryKey, offset: Math.round((row?.getBoundingClientRect().top ?? 0) - top), latest: Math.abs(node.scrollTop) < 2 };
  });
  /** The same place as `seen`: the same row at the top, within the 2 px a phone's device pixels round to. */
  const at = async (seen: { key?: string; offset: number; latest: boolean }) => {
    const now = await place();
    return now.key === seen.key && now.latest === seen.latest && Math.abs(now.offset - seen.offset) <= 2;
  };
  return { bot, scroller, open, place, at };
}

test('each chat opens again where the reader left it, after another chat and after a reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const { scroller, open, place, at } = await chats(page);
  await open(0);
  expect((await place()).latest).toBe(true);
  // Reading back: the conversation scrolls toward its older messages (its scroll origin is the latest message).
  // A wheel turn is the reader's own scroll (the page follows the latest message until the reader scrolls); the scroll is applied
  // in the page, since a phone has no wheel.
  await scroller.evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, bubbles: true, cancelable: true }));
    node.scrollBy({ top: -900, behavior: 'instant' });
  });
  await expect.poll(async () => (await place()).latest).toBe(false);
  const reading = await place();
  await open(1);
  expect((await place()).latest).toBe(true);
  await open(0);
  await expect.poll(() => at(reading)).toBe(true);
  await page.reload();
  const again = await chats(page);
  if (await again.scroller.count() === 0) await again.open(0);
  await expect.poll(() => again.at(reading)).toBe(true);
  // The chat left at its latest message opens there.
  await again.open(1);
  expect((await again.place()).latest).toBe(true);
});
