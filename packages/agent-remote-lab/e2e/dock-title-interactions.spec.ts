import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickSessionAction } from './session-actions';

test.setTimeout(40_000);
const fixture = '/e2e/fixtures/session-family-resize.html?title-drag&content';
const pane = (page: Page, id: string) => page.locator(`.lab-session-family-pane[data-view-id="${id}"]`);
const dock = (page: Page, id: string) => page.locator(`.lab-session-dock-pane[data-dock-id="${id}"]`);
const title = (scope: Locator) => scope.locator('[data-session-title-draggable]').first();
const workspace = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('session-family-resize-window-title-drag')!));
const order = async (page: Page) => (await workspace(page)).views.filter((view: { placement: string }) => view.placement === 'dock').map((view: { id: string }) => view.id);
const translation = (view: Locator) => view.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);

async function point(view: Locator) {
  await view.scrollIntoViewIfNeeded();
  const box = (await view.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('dragging a dock title previews and commits the entire unequal-width family in both directions', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Dock ordering uses a wide viewport.');
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(fixture);
  await expect(dock(page, 'empty')).toBeVisible();
  await expect(title(dock(page, 'dock'))).toHaveAttribute('aria-label', 'Move Dock');
  await expect(pane(page, 'dock-child').locator('[data-session-title-draggable]')).toHaveCount(0);
  await expect(pane(page, 'dock-leaf').locator('[data-session-title-draggable]')).toHaveCount(0);
  for (const id of ['dock', 'dock-child', 'dock-leaf', 'peer']) {
    await pane(page, id).getByTestId('prompt-input').fill(`Unsent ${id} draft`);
    await pane(page, id).getByTestId('prompt-input').evaluate(element => element.setAttribute('data-instance', 'original'));
  }
  await title(dock(page, 'dock')).click();
  await expect.poll(async () => (await workspace(page)).selectedViewId).toBe('dock');
  const primaryBefore = await pane(page, 'primary').boundingBox();
  const rootBefore = (await pane(page, 'dock').boundingBox())!;
  const childBefore = (await pane(page, 'dock-child').boundingBox())!;
  const handle = await point(title(dock(page, 'dock')));
  const peer = (await dock(page, 'peer').boundingBox())!;
  await page.mouse.move(handle.x, handle.y); await page.mouse.down();
  const before = await workspace(page);
  await page.mouse.move(handle.x + peer.width / 2 + 40, handle.y, { steps: 16 });
  await expect.poll(() => translation(dock(page, 'dock'))).toBeGreaterThan(20);
  await expect.poll(() => translation(dock(page, 'peer'))).toBeLessThan(-20);
  expect(await order(page)).toEqual(['dock', 'peer', 'empty']);
  expect((await workspace(page)).revision).toBe(before.revision);
  const rootDuring = (await pane(page, 'dock').boundingBox())!;
  const childDuring = (await pane(page, 'dock-child').boundingBox())!;
  expect(childDuring.x - rootDuring.x).toBeCloseTo(childBefore.x - rootBefore.x, 0);
  await page.screenshot({ path: info.outputPath('dock-title-drag-preview.png') });
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['peer', 'dock', 'empty']);
  expect((await workspace(page)).revision).toBe(before.revision + 1);
  await expect.poll(() => translation(dock(page, 'dock'))).toBe(0);
  const reverse = await point(title(dock(page, 'dock')));
  await page.mouse.move(reverse.x, reverse.y); await page.mouse.down();
  await page.mouse.move(8, reverse.y, { steps: 16 }); await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['dock', 'peer', 'empty']);
  await expect.poll(() => translation(dock(page, 'dock'))).toBe(0);
  const primaryAfter = (await pane(page, 'primary').boundingBox())!;
  expect({ width: primaryAfter.width, height: primaryAfter.height }).toEqual({ width: primaryBefore!.width, height: primaryBefore!.height });
  for (const id of ['dock', 'dock-child', 'dock-leaf', 'peer']) {
    await expect(pane(page, id).getByTestId('prompt-input')).toHaveAttribute('data-instance', 'original');
    await expect(pane(page, id).getByTestId('prompt-input')).toHaveText(`Unsent ${id} draft`);
  }
  await page.screenshot({ path: info.outputPath('dock-title-reordered.png') });
});

test('title clicks select without reordering and Escape cancels the drag preview', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Dock ordering uses a wide viewport.');
  await page.setViewportSize({ width: 1920, height: 900 }); await page.goto(fixture);
  const peer = dock(page, 'peer');
  await title(peer).click();
  await expect.poll(async () => (await workspace(page)).selectedViewId).toBe('peer');
  expect(await order(page)).toEqual(['dock', 'peer', 'empty']);
  const start = await point(title(peer));
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 3, start.y + 1); await page.mouse.up();
  expect(await order(page)).toEqual(['dock', 'peer', 'empty']);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  const revision = (await workspace(page)).revision;
  await page.mouse.move(8, start.y, { steps: 12 });
  await expect.poll(() => translation(peer)).toBeLessThan(-20);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(() => translation(peer)).toBe(0);
  expect(await order(page)).toEqual(['dock', 'peer', 'empty']);
  expect((await workspace(page)).revision).toBe(revision);
  await title(peer).press('Alt+ArrowLeft');
  await expect.poll(() => order(page)).toEqual(['peer', 'dock', 'empty']);
});

test('ordinary and empty panes keep placement and binding actions inside their menus at wide sizes', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Wide controls must also remain collapsed.');
  await page.setViewportSize({ width: 1920, height: 900 }); await page.goto(fixture);
  const view = page.locator('.lab-bindable-session-window[data-view-id="dock"]');
  const empty = page.locator('.lab-bindable-session-window[data-view-id="empty"]');
  const separator = dock(page, 'dock').getByRole('separator', { name: 'Dock width', exact: true });
  for (let step = 0; step < 12; step++) await separator.press('Shift+ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '800');
  expect((await pane(page, 'dock').boundingBox())!.width).toBeGreaterThan(760);
  await expect(view.getByRole('button', { name: 'Float Dock', includeHidden: true })).toBeHidden();
  await expect(view.getByRole('button', { name: 'Change session', includeHidden: true })).toBeHidden();
  await expect(empty.getByRole('button', { name: 'Float Select session', includeHidden: true })).toBeHidden();
  await expect(title(dock(page, 'empty'))).toHaveAttribute('aria-label', 'Move Select session');
  await clickSessionAction(view, 'Change session');
  await expect(page.locator('html')).toHaveAttribute('data-fixture-change-session', 'dock');
  await clickSessionAction(view, 'Float Dock');
  await expect(dock(page, 'dock')).toHaveCount(0);
  await expect(view).toBeVisible();
  await clickSessionAction(view, 'Dock Dock');
  await expect(dock(page, 'dock')).toBeVisible();
  await clickSessionAction(empty, 'Float Select session');
  await expect(dock(page, 'empty')).toHaveCount(0);
  await clickSessionAction(empty, 'Dock Select session');
  await expect(dock(page, 'empty')).toBeVisible();
  await page.screenshot({ path: info.outputPath('dock-title-action-menus.png') });
});

test('Ask and TPM keep placement actions collapsed and TPM title dragging preserves rename', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Wide floating and docked views share the same actions.');
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/e2e/fixtures/tpm-dock.html');
  const list = page.getByRole('region', { name: 'TPM works', exact: true });
  for (const name of ['Search delivery', 'Connection recovery']) {
    await page.getByRole('button', { name: 'TPM works', exact: true }).click();
    await list.locator('[data-tpm-work]').filter({ hasText: name }).click();
    await list.getByRole('button', { name: 'Close TPM works' }).click();
    const view = page.getByRole('dialog', { name: `TPM: ${name}`, exact: true });
    await expect(view.getByRole('button', { name: `Dock ${name}`, exact: true, includeHidden: true })).toBeHidden();
    await clickSessionAction(view, `Dock ${name}`);
    await view.getByTestId('prompt-input').click();
    await expect(view.getByRole('button', { name: `Float ${name}`, exact: true, includeHidden: true })).toBeHidden();
  }
  const first = page.getByRole('region', { name: 'Docked Search delivery', exact: true });
  const second = page.getByRole('region', { name: 'Docked Connection recovery', exact: true });
  await second.getByTestId('prompt-input').fill('Preserve the TPM draft');
  await second.getByTestId('prompt-input').evaluate(element => element.setAttribute('data-instance', 'original-tpm'));
  const rename = second.getByRole('button', { name: 'Rename TPM session', exact: true });
  await rename.click();
  const editor = second.getByRole('textbox', { name: 'TPM session name', exact: true });
  await expect(editor).toHaveValue('Connection recovery');
  await editor.fill('Recovery validation');
  await second.getByRole('button', { name: 'Save', exact: true }).click();
  const renamed = page.getByRole('region', { name: 'Docked Recovery validation', exact: true });
  await expect(renamed).toBeVisible();
  await expect(title(renamed)).toHaveAttribute('aria-label', 'Move Recovery validation');
  const start = await point(renamed.getByRole('button', { name: 'Rename TPM session', exact: true }));
  const destination = (await first.boundingBox())!;
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 3, start.y, { steps: 16 }); await page.mouse.up();
  await expect(renamed).toHaveCSS('order', '1'); await expect(first).toHaveCSS('order', '2');
  await expect(renamed.getByRole('textbox', { name: 'TPM session name', exact: true })).toHaveCount(0);
  await expect(renamed.getByTestId('prompt-input')).toHaveText('Preserve the TPM draft');
  await expect(renamed.getByTestId('prompt-input')).toHaveAttribute('data-instance', 'original-tpm');
  await expect.poll(() => translation(renamed)).toBe(0);
  await clickSessionAction(renamed, 'Float Recovery validation');
  await page.getByRole('dialog', { name: 'TPM: Recovery validation', exact: true }).getByRole('button', { name: 'Minimize TPM', exact: true }).click();
  await page.getByRole('button', { name: 'Open Ask', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const draft = ask.getByRole('textbox', { name: 'Ask draft' });
  await draft.fill('Keep the Ask draft');
  await expect(ask.getByRole('button', { name: 'Dock Ask', exact: true, includeHidden: true })).toBeHidden();
  await clickSessionAction(ask, 'Dock Ask');
  await draft.click();
  await expect(ask.getByRole('button', { name: 'Float Ask', exact: true, includeHidden: true })).toBeHidden();
  await expect(title(page.getByRole('region', { name: 'Docked Ask', exact: true }))).toHaveAttribute('aria-label', 'Move Ask');
  await clickSessionAction(ask, 'Float Ask');
  await expect(draft).toHaveValue('Keep the Ask draft');
  await page.screenshot({ path: info.outputPath('ask-tpm-title-menus.png') });
});

test('narrow panes keep their selection and draft without exposing dock title dragging', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 }); await page.goto(fixture);
  const view = page.locator('.lab-bindable-session-window[data-view-id="peer"]');
  await title(dock(page, 'peer')).click();
  const input = view.getByTestId('prompt-input');
  await input.fill('Keep the selected pane draft');
  await input.evaluate(element => element.setAttribute('data-instance', 'wide-view'));
  const before = await order(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(view).toBeVisible();
  await expect(page.locator('[data-session-title-draggable]')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /^(Dock|Float) /, includeHidden: true })).toHaveCount(0);
  const heading = view.locator('.lab-session-heading-title');
  const start = await point(heading);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y, { steps: 8 }); await page.mouse.up();
  expect(await order(page)).toEqual(before);
  await expect(input).toHaveAttribute('data-instance', 'wide-view');
  await expect(input).toHaveText('Keep the selected pane draft');
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect(title(dock(page, 'peer'))).toHaveAttribute('aria-label', 'Move Peer');
  expect(await order(page)).toEqual(before);
  await expect(input).toHaveAttribute('data-instance', 'wide-view');
});

test('the narrow timeline toolbar exposes session actions through one disclosure', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('agent-remote:track-view', 'false'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/session-stars.html?rename=enabled');
  const toolbar = page.locator('.lab-primary-conversation').getByRole('toolbar', { name: 'Session actions', exact: true });
  const share = toolbar.getByRole('button', { name: 'Share session link', exact: true, includeHidden: true });
  await expect(toolbar.getByRole('button', { name: 'Expand session actions', exact: true })).toBeVisible();
  await expect(share.locator('xpath=ancestor::*[@inert]')).toHaveCount(1);
  await expect(toolbar.getByRole('button', { name: 'More session actions', exact: true, includeHidden: true })).toHaveCount(0);
  await clickSessionAction(page.locator('.lab-primary-conversation'), 'Share session link');
  await expect(share.locator('xpath=ancestor::*[@inert]')).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: 'Share session', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close session link', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: 'Collapse session actions', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('narrow-single-session-menu.png') });
});
