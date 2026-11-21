// Component projects: webkit-mobile-viewport
import { expect, test } from '@playwright/test';

test.beforeEach(async ({}, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Mobile keyboard layout.');
});

for (const reading of [false, true]) {
  test(`positions reflowed long content before the first portrait animation frame (reading=${reading})`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/e2e/fixtures/markdown-reading.html?cached=1');
    const timeline = page.getByTestId('timeline');
    const paragraph = page.locator('.agent-markdown p').filter({ hasText: /^Paragraph 10\./ });
    await expect(paragraph).toBeAttached();
    await expect.poll(() => timeline.evaluate(el => -el.scrollTop)).toBeLessThan(1);
    if (reading) {
      await timeline.dispatchEvent('wheel', { deltaY: -1 });
      await paragraph.evaluate(node => {
        const viewport = node.closest('.lab-timeline-scroll')!;
        viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4;
        viewport.dispatchEvent(new Event('scroll'));
      });
      await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
    }
    // Record the first frame, rather than polling until the later observer catches up.
    await page.evaluate((reading) => {
      const viewport = document.querySelector('[data-testid="timeline"]')!;
      const paragraph = Array.from(viewport.querySelectorAll('.agent-markdown p')).find(el => el.textContent?.startsWith('Paragraph 10.'))!;
      const readingOffset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      window.addEventListener('resize', () => requestAnimationFrame(() => {
        const error = reading
          ? paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - readingOffset
          : -viewport.scrollTop;
        document.documentElement.dataset.rotationPositionError = String(error);
      }), { once: true });
    }, reading);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-rotation-position-error');
    const error = Number(await page.locator('html').getAttribute('data-rotation-position-error'));
    expect(Math.abs(error)).toBeLessThan(1);
    if (reading) await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  });
}


test('keeps latest content attached to the viewport through reflow without scroll writes', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/e2e/fixtures/markdown-reading.html?cached=1');
  const timeline = page.getByTestId('timeline');
  await expect(page.locator('.agent-markdown p').filter({ hasText: /^Paragraph 10\./ })).toBeAttached();
  await timeline.evaluate(element => {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    const writes: number[] = [];
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => native.get!.call(element),
      set: value => { writes.push(value); native.set!.call(element, value); },
    });
    Object.assign(element, { scrollWrites: writes });
  });
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => timeline.evaluate(element => {
      const content = element.firstElementChild!.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      return Math.abs(viewport.bottom - parseFloat(getComputedStyle(element).paddingBottom) - content.bottom);
    })).toBeLessThan(1);
    expect(await timeline.evaluate(element => (element as HTMLElement & { scrollWrites: number[] }).scrollWrites)).toEqual([]);
  }
});


test('keeps a historical entry in place while new messages grow below it', async ({ page }) => {
  await page.goto('/e2e/fixtures/workbench.html');
  const timeline = page.getByTestId('timeline');
  const entry = timeline.locator('[data-entry-key]').nth(15);
  await expect(entry).toBeAttached();
  await entry.evaluate(node => {
    const viewport = node.closest('.lab-timeline-scroll')!;
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 10;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const offset = await entry.evaluate(node => node.getBoundingClientRect().top - node.closest('.lab-timeline-scroll')!.getBoundingClientRect().top);
  for (const name of ['Append live', 'Grow last message']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(() => entry.evaluate((node, offset) => Math.abs(node.getBoundingClientRect().top
      - node.closest('.lab-timeline-scroll')!.getBoundingClientRect().top - offset), offset)).toBeLessThan(1);
  }
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect.poll(() => timeline.evaluate(node => Math.abs(node.scrollTop))).toBeLessThan(1);
});
