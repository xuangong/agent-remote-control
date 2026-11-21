// Component projects: orchard-phone-chromium, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';
import { coveringControls } from './covering';

// The composer in the mockup's form (I4, Task 3): a capsule on the fill colour with "+" at the left, the editor, stop while a turn
// runs, and the round orange send button with dark ink; the + menu stands above it. Bot mode's conversation, both themes, desktop
// and 390 x 844.
const open = async (page: Page, theme: 'light' | 'dark') => {
  await page.goto(`/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief&pending=none&theme=${theme}`);
  await expect(page.locator('.agent-composer-capsule')).toBeVisible();
};

/** A token's colour as the page computes it, for comparing with a control's computed style. */
const token = (page: Page, name: string) => page.evaluate(variable => {
  const probe = document.body.appendChild(document.createElement('span'));
  probe.style.color = `var(${variable})`;
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}, name);

for (const theme of ['light', 'dark'] as const) test(`the capsule, its buttons and its menu in the ${theme} theme`, async ({ page }, info) => {
  await open(page, theme);
  const capsule = page.locator('.agent-composer-capsule').first();
  await expect(capsule).toHaveCSS('border-top-left-radius', '24px');
  await expect(capsule).toHaveCSS('background-color', await token(page, '--orchard-fill'));
  const plus = capsule.getByRole('button', { name: 'More actions', exact: true });
  const input = capsule.getByTestId('prompt-input');
  const stop = capsule.getByRole('button', { name: 'Interrupt', exact: true });
  const send = capsule.getByTestId('prompt-submit');
  await input.click();
  await input.pressSequentially('Draft');
  await expect(send).toBeEnabled();
  await expect(send).toHaveCSS('background-color', await token(page, '--orchard-brand'));
  await expect(send).toHaveCSS('color', await token(page, '--orchard-on-brand'));
  // Left to right: +, the editor, stop (the turn runs), send.
  const box = async (control: typeof plus) => (await control.boundingBox())!;
  const [p, i, s, d] = [await box(plus), await box(input), await box(stop), await box(send)];
  expect(p.x + p.width).toBeLessThanOrEqual(i.x + 1);
  expect(i.x + i.width).toBeLessThanOrEqual(s.x + 1);
  expect(s.x + s.width).toBeLessThanOrEqual(d.x + 1);
  // Under a finger every round button is a 44 px target; with a mouse it is drawn at 32 px.
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  for (const round of [p, s, d]) expect(Math.round(Math.min(round.width, round.height))).toBeGreaterThanOrEqual(coarse ? 44 : 32);
  // Nothing of the composer covers the conversation while its menu is closed.
  expect(await coveringControls(page)).toEqual([]);
  await plus.click();
  const menu = page.getByRole('region', { name: 'More actions', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Open chat commands', exact: true })).toBeVisible();
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThanOrEqual((await capsule.boundingBox())!.y + 1);
  await page.screenshot({ path: info.outputPath(`composer-${theme}.png`) });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(plus).toBeFocused();
});

test('the capsule stays above the keyboard and inside the page at phone width', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('orchard-phone'), 'A phone viewport.');
  await open(page, 'light');
  const capsule = page.locator('.agent-composer-capsule').first();
  await capsule.getByTestId('prompt-input').click();
  // The keyboard takes the lower part of the screen: the visible viewport shrinks.
  await page.setViewportSize({ width: 390, height: 480 });
  await expect.poll(async () => { const box = (await capsule.boundingBox())!; return box.y + box.height <= 480 && box.y >= 0; }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('composer-keyboard.png') });
});

test.describe('in Chinese', () => {
  test.use({ locale: 'zh-CN' });
  test('the placeholder speaks to the assistant, and the menu speaks Chinese', async ({ page }) => {
    await open(page, 'light');
    const capsule = page.locator('.agent-composer-capsule').first();
    const input = capsule.getByTestId('prompt-input');
    await expect.poll(() => input.evaluate(element => element.getAttribute('data-placeholder') ?? element.getAttribute('placeholder'))).toMatch(/^给 .+ 发消息…$/);
    // The empty draft shows it: the rich editor draws it before its first line.
    await expect.poll(() => input.evaluate(element => element.tagName === 'TEXTAREA' ? (element as HTMLTextAreaElement).placeholder : getComputedStyle(element, '::before').content)).toMatch(/给 .+ 发消息…/);
    await input.click();
    await input.pressSequentially('好');
    await expect.poll(() => input.evaluate(element => element.tagName === 'TEXTAREA' ? 'none' : getComputedStyle(element, '::before').content)).toBe('none');
    await capsule.getByRole('button', { name: '更多操作', exact: true }).click();
    await expect(page.getByRole('region', { name: '更多操作', exact: true }).getByRole('button', { name: '打开命令', exact: true })).toBeVisible();
  });
});
