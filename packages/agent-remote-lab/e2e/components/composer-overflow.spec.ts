import { expect, test } from '@playwright/test';
import { activateComposerAction } from '../composer-actions';

test('narrow composed views keep the capsule on one row and open the + menu without losing the draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/fixtures/session-view-responsive.html');
  await page.getByRole('spinbutton', { name: 'View width' }).fill('320');
  const view = page.locator('[data-placement="popup"]');
  const send = view.getByRole('button', { name: 'Send message', exact: true });
  const more = view.getByRole('button', { name: 'More actions', exact: true });
  await expect(more).toBeVisible();
  await expect(view.getByTestId('prompt-input')).toContainText('A draft kept while the view resizes');
  const before = (await view.getByTestId('timeline').boundingBox())!;
  await more.click();
  const menu = view.getByRole('region', { name: 'More actions', exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Open chat commands', exact: true }).click();
  await expect(view.getByRole('listbox', { name: 'Native commands' })).toBeVisible();
  await view.getByTestId('prompt-input').press('Escape');
  await more.click();
  await menu.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(view.getByRole('region', { name: 'Permission settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view.getByRole('region', { name: 'Permission settings' })).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await menu.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(view.getByRole('region', { name: 'Session status', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view.getByRole('region', { name: 'Session status', exact: true })).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  const chooser = page.waitForEvent('filechooser');
  await activateComposerAction(view, 'Add images');
  await (await chooser).setFiles([]);
  await expect(menu).toBeHidden();
  expect(Math.abs((await view.getByTestId('timeline').boundingBox())!.height - before.height)).toBeLessThan(0.5);
  for (const width of [320, 390, 440, 700, 900, 320]) {
    await page.getByRole('spinbutton', { name: 'View width' }).fill(String(width));
    await expect.poll(() => view.evaluate(element => {
      const send = element.querySelector('[data-testid="prompt-submit"]')!.getBoundingClientRect();
      // "+" (and stop while a turn runs) stand on the send button's line, to its left.
      return [...element.querySelectorAll('.agent-composer-capsule :is(.agent-composer-plus, .agent-composer-stop)')].filter(button => button.getClientRects().length)
        .every(button => { const box = button.getBoundingClientRect(); return Math.abs(box.y + box.height / 2 - send.y - send.height / 2) < 1 && box.right <= send.x; });
    })).toBe(true);
    await expect(send).toBeVisible();
    expect(await view.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await more.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(view.getByTestId('prompt-input')).toContainText('A draft kept while the view resizes');
  // The menu is the same at every width: it stays open across a resize and closes back to "+".
  await more.click();
  await page.getByRole('spinbutton', { name: 'View width' }).fill('900');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  // Escape closes the menu from inside the composer (focus left it for the width field).
  await more.focus();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  // Opening one of the composer's popovers closes the other: a setting's panel, then the command list.
  await activateComposerAction(view, 'Model');
  await expect(view.getByRole('region', { name: 'Model settings' })).toBeVisible();
  await activateComposerAction(view, 'Open chat commands');
  await expect(view.getByRole('region', { name: 'Model settings' })).toBeHidden();
  await expect(view.getByRole('listbox', { name: 'Native commands' })).toBeVisible();
  await view.getByTestId('prompt-input').press('Escape');
  await page.getByRole('spinbutton', { name: 'View width' }).fill('320');
  await expect(more).toBeVisible();
  await page.screenshot({ path: info.outputPath('composer-overflow.png') });
});
