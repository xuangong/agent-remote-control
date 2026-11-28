// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Locator, type Page } from '@playwright/test';

// The reader's place in a workbench conversation survives folding and leaving: on a desktop a tile folded to its strip and expanded again, on a
// phone a conversation popped back to the list and pushed again, show the same message at the same offset (within the 2 px device pixels round to).
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 760;
const open = async (page: Page, motion: 'no-preference' | 'reduce' = 'no-preference') => {
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto(`/e2e/fixtures/bot-workbench.html?conversations&subs=3${phone(page) ? '&phone' : ''}`);
  await expect(page.locator(phone(page) ? '.lab-workbench-overview' : '[data-primary-group-id="main"]')).toBeVisible();
};
const place = (scroller: Locator) => scroller.evaluate(node => {
  const top = node.getBoundingClientRect().top;
  const row = [...node.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.getBoundingClientRect().bottom > top + 1);
  return { key: row?.dataset.entryKey, offset: Math.round((row?.getBoundingClientRect().top ?? 0) - top), latest: Math.abs(node.scrollTop) < 2 };
});
/** The reader scrolls toward older messages, then the page has taken the new line (the scroll event and two frames). */
const readBack = async (scroller: Locator, distance: number) => {
  await scroller.evaluate((node, distance) => new Promise<void>(settled => {
    node.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(() => settled())), { once: true });
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -distance, bubbles: true, cancelable: true }));
    node.scrollBy({ top: -distance, behavior: 'instant' });
  }), distance);
  await expect.poll(async () => (await place(scroller)).latest).toBe(false);
  return place(scroller);
};
const back = async (scroller: Locator, seen: Awaited<ReturnType<typeof place>>) => {
  await expect.poll(async () => {
    const now = await place(scroller);
    return now.key === seen.key && now.latest === seen.latest && Math.abs(now.offset - seen.offset) <= 2;
  }).toBe(true);
};

// With reduced motion the system's rule shortens every transition to .01 ms: the width a pane regains still takes a frame, which the
// conversation must not mount into.
for (const motion of ['no-preference', 'reduce'] as const) for (const [name, id, strip] of [['the main tile', 'main', false], ['a sub-session tile', 'sub:s1', true]] as const) {
  test(`${name} folded and expanded again shows the message the reader was on (motion: ${motion})`, async ({ page }) => {
    test.skip(phone(page), 'The desktop rail folds tiles; a phone pops back to the list.');
    await open(page, motion);
    const pane = page.locator(`[data-primary-group-id="${id}"]`);
    if (strip) await pane.locator('button.lab-folded-bot').click();
    const scroller = pane.locator('.lab-timeline-scroll');
    await expect(scroller.locator('[data-entry-key]').first()).toBeVisible();
    const seen = await readBack(scroller, 1100);
    await pane.getByRole('button', { name: /^Minimize/ }).click();
    await expect(pane).toHaveAttribute('data-minimized', 'true');
    await pane.getByRole('button', { name: /^Restore|^Expand/ }).click();
    await expect(scroller.locator('[data-entry-key]').first()).toBeVisible();
    await back(scroller, seen);
  });
}

for (const [name, row] of [['the main conversation', 'main'], ['a sub-session conversation', 'sub:s2']] as const) {
  test(`${name} popped back to the list and pushed again shows the message the reader was on`, async ({ page }) => {
    test.skip(!phone(page), 'A phone pushes a conversation from the list.');
    await open(page);
    const scroller = page.locator('.lab-timeline-scroll:visible');
    await page.locator(`[data-tile="${row}"]`).click();
    await expect(scroller.locator('[data-entry-key]').first()).toBeVisible();
    const seen = await readBack(scroller, 1100);
    await page.getByRole('button', { name: /^‹/ }).click();
    await expect(page.locator('.lab-workbench-overview')).toBeVisible();
    await page.locator(`[data-tile="${row}"]`).click();
    await expect(scroller.locator('[data-entry-key]').first()).toBeVisible();
    await back(scroller, seen);
  });
}
