import { expect, test, type Locator } from '@playwright/test';
import { activateComposerAction, revealComposerAction } from './composer-actions';

async function composerGeometry(view: Locator) {
  return view.evaluate(element => {
    const frame = element.querySelector('.lab-session-view')!.getBoundingClientRect();
    return ['.agent-composer', '.agent-composer-actions', '.agent-session-controls', '.agent-activity', '[data-testid="prompt-submit"]'].map(selector => {
      const rect = element.querySelector(selector)!.getBoundingClientRect();
      return [rect.x - frame.x, rect.y - frame.y, rect.width, rect.height].map(value => Math.round(value));
    });
  });
}

test('composed Session Views keep the same controls and responsive layout at equal container sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/fixtures/session-view-responsive.html');
  const views = page.locator('[data-placement]');
  await expect(views).toHaveCount(3);
  for (const [width, height] of [[900, 700], [440, 560], [320, 560], [360, 320], [440, 400]] as const) {
    await page.getByRole('spinbutton', { name: 'View width' }).fill(String(width));
    await page.getByRole('spinbutton', { name: 'View height' }).fill(String(height));
    for (const view of await views.all()) {
      // Wait for container-query typography to settle before measuring menu effects.
      await expect(view.getByTestId('prompt-input')).toHaveCSS('font-size', width > 760 ? '14px' : '16px');
      await expect(view.getByRole('button', { name: 'Hide message input', exact: true })).toBeVisible();
      await expect(view.getByTestId('turn-elapsed')).toBeVisible();
      for (const name of ['Add images', 'Open chat commands', 'Model', 'Permissions']) {
        const { action, trigger } = await revealComposerAction(view, name, true);
        await expect(action).toBeVisible();
        const menu = view.getByRole('region', { name: 'More actions', exact: true });
        if (await menu.isVisible()) {
          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(trigger).toBeFocused();
        }
      }
      const contained = await view.evaluate(element => {
        const frame = element.querySelector('.lab-session-view')!.getBoundingClientRect();
        return [...element.querySelectorAll('.agent-composer-actions button')].filter(button => button.getClientRects().length).every(button => {
          const rect = button.getBoundingClientRect();
          return rect.left >= frame.left && rect.right <= frame.right + 1 && rect.top >= frame.top && rect.bottom <= frame.bottom + 1;
        });
      });
      expect(contained).toBe(true);
    }
    for (const view of (await views.all()).slice(1)) await expect.poll(async () => {
      const reference = await composerGeometry(views.first());
      return JSON.stringify(await composerGeometry(view)) === JSON.stringify(reference);
    }).toBe(true);

    const popup = views.last();
    const timeline = popup.getByTestId('timeline');
    const timelineGeometry = () => timeline.evaluate(element => {
      const frame = element.closest('.lab-session-view')!.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return [rect.x - frame.x, rect.y - frame.y, rect.width, rect.height];
    });
    const before = await timelineGeometry();
    const statusTrigger = await activateComposerAction(popup, 'Status');
    const panel = popup.getByRole('region', { name: 'Session status', exact: true });
    await expect(panel).toBeVisible();
    const bounds = (await popup.locator('.lab-session-view').boundingBox())!;
    const settings = (await panel.boundingBox())!;
    expect(settings.height).toBeGreaterThan(120);
    expect(settings.y).toBeGreaterThanOrEqual(bounds.y);
    expect(settings.y + settings.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(await timelineGeometry()).toEqual(before);
    await panel.getByRole('button', { name: 'Close session controls' }).click();
    await expect(statusTrigger).toBeFocused();
  }
});


test('command details adapt to a narrow Session View inside a wide desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/e2e/fixtures/session-view-responsive.html');
  const view = page.locator('[data-placement="popup"]');
  await activateComposerAction(view, 'Open chat commands');
  await view.getByRole('option', { name: /review/ }).click();
  const timeline = view.getByTestId('timeline');
  const before = (await timeline.boundingBox())!;
  await view.getByRole('button', { name: 'View skill review', exact: true }).click();
  const details = view.getByRole('complementary', { name: 'Skill details' });
  await expect(details).toBeVisible();
  const frame = (await view.locator('.lab-session-view').boundingBox())!;
  const panel = (await details.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(frame.x);
  expect(panel.x + panel.width).toBeLessThanOrEqual(frame.x + frame.width);
  expect(panel.width).toBeGreaterThan(250);
  expect((await timeline.boundingBox())!.width).toBe(before.width);
  await details.getByRole('button', { name: 'Close skill details' }).click();
  await expect(details).toBeHidden();
  await expect(view.getByTestId('prompt-input')).toContainText('A draft kept while the view resizes');
});

test('direct commands close session settings in a wide Session View', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/e2e/fixtures/session-view-responsive.html');
  await page.getByRole('spinbutton', { name: 'View width' }).fill('900');
  const view = page.locator('[data-placement="popup"]');
  const commands = view.locator('.agent-session-toolbar').getByRole('button', { name: 'Open chat commands', exact: true });
  await expect(commands).toBeVisible();
  const before = (await view.getByTestId('timeline').boundingBox())!;
  await activateComposerAction(view, 'Model', true);
  const settings = view.getByRole('region', { name: 'Model settings', exact: true });
  await expect(settings).toBeVisible();
  await commands.click();
  await expect(settings).toBeHidden();
  await expect(view.getByRole('listbox', { name: 'Native commands' })).toBeVisible();
  expect((await view.getByTestId('timeline').boundingBox())!.height).toBe(before.height);
  await view.getByTestId('prompt-input').press('Escape');
  await expect(view.getByTestId('prompt-input')).toContainText('A draft kept while the view resizes');
});
