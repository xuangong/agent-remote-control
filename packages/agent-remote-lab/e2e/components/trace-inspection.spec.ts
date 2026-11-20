import { expect, test } from '@playwright/test';
import { toggleViewPanel } from '../view-options';
import { showNewSession } from '../session-navigation';



test('inspects a live tool and returns to a stable conversation anchor', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Full: the live tool shows in the conversation at preview level, as the preview display showed it.
  await page.addInitScript(() => localStorage.setItem('agent-remote:process-mode', 'full'));
  await page.goto('/e2e/fixtures/trace-inspection.html');
  const prompt = page.getByTestId('prompt-input');
  await prompt.fill('Keep this draft');
  const viewport = page.getByTestId('timeline');
  const entry = viewport.locator('[data-entry-key="recorded:12:test-call"]');
  await viewport.hover();
  await page.mouse.wheel(0, -3000);
  await entry.scrollIntoViewIfNeeded();
  await entry.hover();
  const inspectButton = entry.getByRole('button', { name: 'Inspect event in Trace', includeHidden: true });
  if (page.viewportSize()!.width <= 1180) {
    await expect(inspectButton).toBeHidden();
    await expect(viewport.getByRole('button', { name: /Inspect event in Trace/ })).toHaveCount(0);
    if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
    await page.getByRole('tab', { name: 'Trace', exact: true }).click();
    await page.locator('[data-trace-entry-key="recorded:12:test-call"]').click();
  } else {
    await expect(inspectButton).toBeVisible();
    await inspectButton.click();
  }
  const details = page.getByRole('region', { name: 'Trace entry details' });
  await expect(details).toBeVisible();
  await expect(details).toContainText('pnpm test --testTimeout=10000');
  await expect(details).toContainText('No result received yet');
  await page.getByRole('button', { name: 'Complete tool', exact: true }).click();
  await expect(details).toContainText('All tests passed.');
  await expect(details).toContainText('1200 ms');
  await expect(page.locator('[data-trace-entry-key][aria-current="true"]')).toHaveAttribute('data-trace-entry-key', 'recorded:12:test-call');
  if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
  await details.evaluate(element => { element.scrollTop = 160; });
  const detailTop = await details.evaluate(element => element.scrollTop);
  await page.getByRole('tab', { name: 'Workbench', exact: true }).click();
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await expect.poll(() => details.evaluate(element => element.scrollTop)).toBe(detailTop);
  await expect.poll(() => page.locator('.lab-trace-browser').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('trace-details.png') });
  await details.getByRole('button', { name: 'Show in Conversation' }).click();
  await expect(entry).toHaveAttribute('data-inspected', 'true');
  await expect(prompt).toHaveText('Keep this draft');
  const anchor = await entry.evaluate(element => element.getBoundingClientRect().top);
  const top = await viewport.evaluate(element => element.scrollHeight - element.clientHeight + element.scrollTop);
  await page.getByRole('button', { name: 'Append event', exact: true }).click();
  // Within one CSS pixel: at a fractional device pixel ratio (Pixel 7, 2.625) the anchor rounds to a device pixel.
  await expect.poll(() => viewport.evaluate((element, top) => Math.abs(element.scrollHeight - element.clientHeight + element.scrollTop - top), top)).toBeLessThanOrEqual(1);
  expect(Math.abs(await entry.evaluate(element => element.getBoundingClientRect().top) - anchor)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, 160);
  // Wait for the wheel itself: the one-pixel anchor rounding above is not a move.
  await expect.poll(() => viewport.evaluate((element, top) => Math.abs(element.scrollHeight - element.clientHeight + element.scrollTop - top), top)).toBeGreaterThan(1);
  const readingTop = await viewport.evaluate(element => element.scrollHeight - element.clientHeight + element.scrollTop);
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await page.getByRole('tab', { name: 'Workbench', exact: true }).click();
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight + element.scrollTop)).toBe(readingTop);
  expect(errors).toEqual([]);
});


test('filters trace events, restores list focus, and resets inspection on an epoch change', async ({ page }) => {
  await page.goto('/e2e/fixtures/trace-inspection.html');
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
  if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search trace' }).fill('pnpm test');
  const rows = page.locator('[data-trace-entry-key]');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  const details = page.getByRole('region', { name: 'Trace entry details' });
  await expect(details).toBeFocused();
  await details.press('Escape');
  await expect(rows.first()).toBeFocused();
  await rows.first().press('Enter');
  await expect(details).toContainText('/workspace/example');
  await page.getByRole('button', { name: 'Replace timeline', exact: true }).click();
  await expect(page.locator('[data-trace-entry-key][aria-current="true"]')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search trace' })).toHaveText('');
});
