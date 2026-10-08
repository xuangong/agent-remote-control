import { expect, test } from '@playwright/test';

test.use({ locale: 'en-GB', timezoneId: 'Asia/Shanghai' });

test('keeps tool descriptions readable as a desktop timeline container narrows', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Desktop containers retain inline timestamps');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/e2e/fixtures/ask-timeline-layout.html');
  const timeline = page.getByRole('main', { name: 'Tool timeline' });
  const tools = timeline.locator('.agent-tool');
  await expect(tools).toHaveCount(4);
  for (const width of [320, 440, 600]) {
    await timeline.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
    for (const tool of await tools.all()) {
      await expect(tool.locator('.agent-title-time')).toBeVisible();
      await expect(tool.locator('.agent-state-label')).toBeVisible();
      const geometry = await tool.evaluate(element => {
        const header = element.querySelector('.agent-item-header')!.getBoundingClientRect();
        const title = element.querySelector('.agent-timeline-title')!.getBoundingClientRect();
        const summary = element.querySelector('.agent-tool-summary')!.getBoundingClientRect();
        return { headerWidth: header.width, summaryWidth: summary.width, summaryTop: summary.top, titleBottom: title.bottom, height: element.getBoundingClientRect().height, overflow: element.scrollWidth > element.clientWidth };
      });
      expect(geometry.summaryWidth).toBeGreaterThan(geometry.headerWidth * 0.75);
      expect(geometry.summaryTop).toBeGreaterThanOrEqual(geometry.titleBottom);
      expect(geometry.height).toBeLessThan(132);
      expect(geometry.overflow).toBe(false);
    }
    await page.screenshot({ path: testInfo.outputPath(`tool-timeline-${width}.png`) });
  }
  await timeline.evaluate(element => { element.style.width = '1000px'; });
  const wideGeometry = await tools.first().evaluate(element => {
    const title = element.querySelector('.agent-timeline-title')!.getBoundingClientRect();
    const summary = element.querySelector('.agent-tool-summary')!.getBoundingClientRect();
    return { titleRight: title.right, summaryLeft: summary.left, summaryTop: summary.top, titleBottom: title.bottom };
  });
  expect(wideGeometry.summaryLeft).toBeGreaterThan(wideGeometry.titleRight);
  expect(wideGeometry.summaryTop).toBeLessThan(wideGeometry.titleBottom);
});

test('keeps complete details and session navigation available in a narrow timeline', async ({ page, isMobile }) => {
  await page.goto('/e2e/fixtures/ask-timeline-layout.html');
  const source = page.locator('[data-entry-key="layout:codex:2:source"]');
  const toggle = source.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  if (isMobile) await toggle.tap(); else await toggle.click();
  await expect(source.locator('.agent-tool-details')).toContainText('Return enough context to answer the question without changing the source session.');
  const linked = page.locator('[data-entry-key="layout:codex:3:linked"]');
  const link = linked.getByRole('link', { name: '/root/verify_sdk_boundary', exact: true });
  if (isMobile) await link.tap(); else await link.click();
  await expect(page).toHaveURL(/#child$/);
  await expect(linked.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
});
