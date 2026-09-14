import { expect, test, type Locator } from '@playwright/test';
import { toggleViewPanel } from './view-options';

async function expectContained(container: Locator) {
  const overflow = await container.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { width: element.scrollWidth - element.clientWidth, left: bounds.left, right: bounds.right, viewport: innerWidth };
  });
  expect(overflow.width, await container.getAttribute('class') ?? 'container').toBeLessThanOrEqual(1);
  expect(overflow.left).toBeGreaterThanOrEqual(-1);
  expect(overflow.right).toBeLessThanOrEqual(overflow.viewport + 1);
}

for (const width of [320, 390, 844, 1440]) {
  test(`keeps failed command output compact and readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/e2e/fixtures/view-overflow.html?view=tool-error');
    const error = page.getByRole('alert');
    await expect(error).toContainText('diff --git');
    await expect(page.locator('.agent-tool-toggle')).toHaveAttribute('aria-expanded', 'false');
    const typography = await error.evaluate(element => {
      const style = getComputedStyle(element);
      return { size: parseFloat(style.fontSize), whitespace: style.whiteSpace, font: style.fontFamily, height: element.clientHeight, scrollHeight: element.scrollHeight };
    });
    expect(typography.size).toBe(12);
    expect(typography.whitespace).toBe('pre-wrap');
    expect(typography.font).toContain('monospace');
    expect(typography.height).toBeLessThanOrEqual(320);
    expect(typography.scrollHeight).toBeGreaterThan(typography.height);
    await expectContained(error);
    await expectContained(page.getByTestId('timeline'));
    await error.focus();
    await expect(error).toBeFocused();
    await error.press('ArrowDown');
    await expect.poll(() => error.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath(`failed-command-${width}.png`) });
  });

  for (const view of ['workbench', 'timeline', 'trace', 'inspector', 'command']) {
    test(`contains every rendered content type in ${view} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 740 });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`/e2e/fixtures/view-overflow.html?view=${view}`);
      await expect(page.locator('main > *')).toBeVisible();
      for (const toggle of await page.locator('.agent-tool-toggle, .agent-reasoning-toggle, .agent-notice-toggle, .agent-question-context-toggle').all()) await toggle.click();
      await expectContained(page.locator('main'));
      const overflow = await page.locator('main').evaluate(root => [...root.querySelectorAll<HTMLElement>('*')].flatMap(element => {
        if (!element.getClientRects().length) return [];
        // Code and tables own horizontal scrolling; their descendants may be wider.
        if (element.closest('pre, .agent-markdown-table')) return [];
        if (element.closest('.agent-visually-hidden, option')) return [];
        const style = getComputedStyle(element);
        const ellipsis = style.textOverflow === 'ellipsis' && style.overflowX === 'hidden';
        if (element.parentElement && getComputedStyle(element.parentElement).textOverflow === 'ellipsis'
          && getComputedStyle(element.parentElement).overflowX === 'hidden') return [];
        const rect = element.getBoundingClientRect();
        return element.scrollWidth > element.clientWidth + 1 && style.display !== 'inline' && !ellipsis && element.tagName !== 'SELECT'
          || rect.left < -1 || rect.right > innerWidth + 1
          ? [{ tag: element.tagName, class: element.className, width: element.clientWidth, scroll: element.scrollWidth, right: rect.right }] : [];
      }));
      expect(overflow).toEqual([]);
      if (view === 'trace') {
        const clippedRows = await page.locator('.lab-trace-list > li').evaluateAll(rows => rows.flatMap(row => {
          const bounds = row.getBoundingClientRect();
          return [...row.children].some(child => {
            const content = child.getBoundingClientRect();
            return content.top < bounds.top - 1 || content.bottom > bounds.bottom + 1;
          }) ? [row.textContent?.slice(0, 80)] : [];
        }));
        expect(clippedRows).toEqual([]);
      }
      if (view === 'workbench' || view === 'timeline') {
        await expect(page.locator('.agent-resources li')).toHaveCount(4);
        await expect(page.locator('.agent-tool-details:visible')).toHaveCount(7);
        await expect(page.locator('.agent-interactions > *')).toHaveCount(6);
        const code = page.locator('.agent-markdown pre').first();
        expect(await code.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        const table = page.getByRole('region', { name: 'Markdown table' }).first();
        if (width <= 390) expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        for (const localScroller of [code, table]) {
          const bounds = (await localScroller.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
      }
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${view}-${width}.png`) });
    });
  }
}

for (const width of [320, 390, 844, 1440]) {
  test(`contains long resources and all controller views at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/');
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByTestId('session-create').click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    const path = `artifacts/${'resource'.repeat(64)}.txt`;
    await page.getByTestId('prompt-input').fill(`Download [long resource](${path}).`);
    await page.getByTestId('prompt-submit').click();
    const resource = page.locator('.agent-resources li').filter({ hasText: path }).last();
    await expect(resource).toBeVisible();
    await expectContained(resource);
    await expectContained(page.getByTestId('timeline'));
    await page.screenshot({ path: testInfo.outputPath(`resources-${width}.png`) });
    await toggleViewPanel(page, 'Header');
    await expectContained(page.locator('.lab-app-bar'));
    await page.getByRole('tab', { name: 'Trace', exact: true }).click();
    await expectContained(page.locator('.lab-trace-layout'));
    await expectContained(page.locator('.lab-trace-list'));
    await toggleViewPanel(page, 'Replica Inspector');
    await expectContained(page.locator('#lab-inspector'));
    if (width <= 1180) await page.getByRole('button', { name: 'Close Replica Inspector' }).click();
    await toggleViewPanel(page, 'Sidebar');
    await expectContained(page.locator('#lab-context'));
  });
}
