// Component projects: orchard-phone-webkit
import { expect, test } from '@playwright/test';
import { coveringControls } from './covering.js';
import { draftOf, longConversationFixture, lowerKeyboard, openConversation, raiseKeyboard } from './phone-conversation.js';

// What a phone's width and visible area do to a conversation of the Window-mode Workbench (the whole App on a stubbed transport).

for (const width of [320, 390, 844]) {
  test(`at ${width}px the session stays fixed sideways while its conversation scrolls up and down`, async ({ page }) => {
    await openConversation(page, { width, height: width > 390 ? 390 : 844 }, false, longConversationFixture);
    const family = page.locator('.lab-session-dock-rail');
    const timeline = family.getByTestId('timeline');
    await expect(timeline).toContainText('Item 30.');
    await expect.poll(() => family.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    const initial = (await timeline.boundingBox())!;
    for (const offset of [200, -200]) {
      expect(await family.evaluate((element, offset) => { element.scrollLeft = offset; return element.scrollLeft; }, offset)).toBe(0);
      expect((await timeline.boundingBox())!.x).toBe(initial.x);
    }
    // The conversation itself scrolls: it is anchored to its latest row, so reading up is a negative offset.
    expect(await timeline.evaluate(element => { element.scrollTop = -100; return element.scrollTop; })).toBeLessThan(0);
    await family.getByRole('button', { name: 'Expand session actions', exact: true }).click();
    await expect.poll(() => family.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    await family.getByRole('button', { name: 'Collapse session actions', exact: true }).click();
    await expect.poll(() => family.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test('on a 320px phone the capsule keeps its + and Send on one row at touch size, and the page does not scroll sideways', async ({ page }, info) => {
  await openConversation(page, { width: 320, height: 640 });
  const capsule = page.locator('.agent-composer-capsule');
  const plus = (await capsule.getByRole('button', { name: 'More actions' }).boundingBox())!;
  const send = (await page.getByTestId('prompt-submit').boundingBox())!;
  expect(Math.abs(plus.y + plus.height / 2 - (send.y + send.height / 2))).toBeLessThanOrEqual(4);
  expect(send.x + send.width).toBeLessThanOrEqual(320);
  expect(send.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: info.outputPath('phone-320.png') });
});

test('a command menu and the composer stay inside a contracted visual viewport, and a pinch zoom does not resize the shell', async ({ page }, info) => {
  const input = await openConversation(page);
  const shell = page.locator('.lab-shell');
  await input.fill('/');
  await raiseKeyboard(page, { height: 400, offsetTop: 20 });
  await expect.poll(async () => { const bounds = (await page.getByTestId('prompt-submit').boundingBox())!; return bounds.y + bounds.height; }).toBeLessThanOrEqual(420);
  await expect(page.getByRole('listbox', { name: 'Native commands' })).toBeVisible();
  const menu = (await page.locator('.agent-command-menu').boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(20);
  expect(menu.y + menu.height).toBeLessThanOrEqual(420);
  // With the keyboard up the menu stands above the capsule: nothing covers the command being typed (O58).
  expect(await coveringControls(page, '.agent-composer-capsule')).toEqual([]);
  await page.screenshot({ path: info.outputPath('contracted-viewport.png') });
  // A shorter visible area still holds the whole menu: it shrinks to the room above the composer.
  await raiseKeyboard(page, { height: 200, offsetTop: 140 });
  await expect(shell).toHaveCSS('height', '200px');
  const squeezed = (await page.locator('.agent-command-menu').boundingBox())!;
  expect(squeezed.y).toBeGreaterThanOrEqual(140);
  expect(squeezed.y + squeezed.height).toBeLessThanOrEqual(340);
  // The launchers wait below the keyboard, so Send stays in the visible area of a short view too (O58).
  await expect(page.locator('.lab-launcher-bar')).toBeHidden();
  const send = (await page.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y).toBeGreaterThanOrEqual(140);
  expect(send.y + send.height).toBeLessThanOrEqual(340);
  await raiseKeyboard(page, { height: 400, offsetTop: 20 });
  await expect(shell).toHaveCSS('height', '400px');
  // A pinched visual viewport is not a keyboard: the shell keeps the height it had.
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 200, offsetTop: 40, scale: 2 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  expect((await shell.boundingBox())!.height).toBe(400);
  await page.evaluate(() => { Object.assign(window.visualViewport!, { scale: 1 }); });
  await lowerKeyboard(page);
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  expect(await draftOf(page)).toBe('/');
});
