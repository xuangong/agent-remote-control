import { expect, test, type Page } from '@playwright/test';
import { toggleViewPanel } from '../view-options';

// The movable floating controls (Window, Team, TPM) start in a column at the right edge. At phone and tablet widths the app bar has
// several rows and the timeline toolbar sits under it; the default column must start below both, in light and dark.
const widths = [320, 390, 412, 600, 800];

async function overlaps(page: Page) {
  return page.evaluate(() => {
    const floating = [...document.querySelectorAll('.lab-tracking-floating')].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0);
    const controls = [...document.querySelectorAll('.lab-app-bar :is(button, [role="tab"], a, summary), .lab-timeline-tools :is(button, summary)')]
      .map(element => ({ name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 20) ?? '', rect: element.getBoundingClientRect() }))
      .filter(control => control.rect.width > 0 && control.rect.height > 0);
    const hits = floating.flatMap(box => controls.filter(({ rect }) => box.left < rect.right && rect.left < box.right && box.top < rect.bottom && rect.top < box.bottom).map(control => control.name));
    return { floating: floating.length, controls: controls.length, hits };
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of widths) {
    test(`the floating controls start clear of the header and session controls at ${width}px in ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/e2e/fixtures/trace-inspection.html');
      await expect(page.getByTestId('prompt-input')).toBeEnabled();
      if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
      await expect(page.getByRole('tab', { name: 'Trace', exact: true })).toBeVisible();
      await expect(page.locator('.lab-tracking-floating').first()).toBeVisible();
      await expect.poll(async () => (await overlaps(page)).hits).toEqual([]);
      const found = await overlaps(page);
      expect(found.floating).toBeGreaterThan(0);
      expect(found.controls).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath(`floating-${colorScheme}-${width}.png`) });
    });
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`an open View options panel is not covered by the floating controls at 320px in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/e2e/fixtures/trace-inspection.html');
    await expect(page.locator('.lab-tracking-floating').first()).toBeVisible();
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    const panel = page.getByRole('region', { name: 'View options', exact: true });
    await expect(panel).toBeVisible();
    const covered = await panel.getByRole('checkbox').evaluateAll(boxes => boxes.flatMap(box => {
      const rect = box.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top === box || top?.closest('label') === box.closest('label') ? [] : [box.closest('label')?.textContent?.trim() ?? ''];
    }));
    expect(covered).toEqual([]);
  });
}
