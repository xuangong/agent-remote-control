// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// Reduced motion (I5d), asked by the system or chosen on this device in Settings > General: once the page settles nothing on it moves,
// neither a chat pushed in on a phone, a sheet, the typing dots of a working assistant, nor an avatar.
const url = '/e2e/fixtures/window-tiles.html?tiles=2&bots=1&mode=bot&working=tile-1,tile-2';

/** The page's animations still running after a short wait, as their names, durations and iteration counts. */
const moving = (page: Page) => page.evaluate(async () => {
  await new Promise(resolve => setTimeout(resolve, 150));
  return document.getAnimations().filter(animation => animation.playState === 'running').map(animation => {
    const timing = animation.effect!.getComputedTiming();
    return { name: (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? 'script', duration: Number(timing.duration), iterations: timing.iterations };
  }).filter(animation => animation.duration > 1 || animation.iterations === Infinity);
});

for (const source of ['system', 'device'] as const) test(`with reduced motion from the ${source}, opening a chat and a sheet moves nothing`, async ({ page }) => {
  if (source === 'device') await page.addInitScript(() => localStorage.setItem('agent-remote:motion', 'reduce'));
  await page.emulateMedia({ reducedMotion: source === 'system' ? 'reduce' : 'no-preference' });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-motion', source === 'device' ? 'reduce' : /.*/);
  const bot = page.locator('[data-workbench-mode="bot"]');
  await bot.locator('[data-bot-place]').first().click();
  await expect(bot.locator('.lab-timeline-scroll:visible')).toHaveCount(1);
  expect(await moving(page)).toEqual([]);
  // A sheet slides up when motion is allowed: New assistant on a wide screen, the assistant's details on a phone.
  if ((page.viewportSize()?.width ?? 1440) > 760) await bot.getByRole('button', { name: 'New assistant' }).first().click();
  else await bot.locator('button.lab-assistant-title').click();
  await expect(page.locator('dialog.orchard-sheet[open]')).toBeVisible();
  expect(await moving(page)).toEqual([]);
});

test('without reduced motion the page still moves: the same check finds the working assistant\'s typing dots', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(url);
  const bot = page.locator('[data-workbench-mode="bot"]');
  await bot.locator('[data-bot-place]').first().click();
  await expect(bot.locator('.orchard-typing').first()).toBeVisible();
  expect((await moving(page)).length).toBeGreaterThan(0);
});
