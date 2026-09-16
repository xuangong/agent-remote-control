import { expect, test, type Locator } from '@playwright/test';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test.beforeEach(async ({ page }) => { await page.goto('/e2e/fixtures/workbench.html'); });

test('starts at the latest content and follows streaming growth and composer resizing', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Grow last message' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  const input = page.getByTestId('prompt-input');
  const before = (await input.boundingBox())!.height;
  await input.fill('first\nsecond\nthird\nfourth\nfifth');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(before);
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('first\nsecond\nthird\nfourth\nfifth\n');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
});

test('protects earlier reading from live updates and resumes following on request', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await timeline.hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const before = await timeline.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Append live' }).click();
  await page.getByRole('button', { name: 'Grow last message' }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toHaveCount(0);
});

test('anchors earlier history by visible entry while live content also arrives', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await timeline.hover();
  await page.mouse.wheel(0, -100);
  await timeline.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.getByRole('button', { name: 'Loading earlier activity…' })).toBeDisabled();
  expect(await timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const anchor = await visibleAnchor(timeline);
  await page.getByRole('button', { name: 'Append live' }).click();
  await page.getByRole('button', { name: 'Complete history with live' }).click();
  await expect(timeline.locator('.agent-timeline-entry')).toHaveCount(52);
  await expect.poll(async () => timeline.evaluate((element, expected) => {
    const entry = Array.from(element.querySelectorAll<HTMLElement>('[data-entry-key]')).find((node) => node.dataset.entryKey === expected.key)!;
    return entry.getBoundingClientRect().top - element.getBoundingClientRect().top - expected.offset;
  }, anchor)).toBeCloseTo(0, 0);
});

test('protects keyboard reading and follows again after returning to the end', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await timeline.press('Home');
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(0);
  await timeline.press('End');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
});

test('keeps following after navigation that does not move earlier', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  for (const key of ['End', 'PageDown', 'ArrowDown']) {
    await timeline.press(key);
    await timeline.evaluate((element) => { element.scrollTop -= 100; });
    await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
    await expect(page.getByRole('button', { name: 'Back to latest' })).toHaveCount(0);
  }
  const input = page.getByTestId('prompt-input');
  await input.fill('first\nsecond');
  await input.press('ArrowUp');
  await timeline.evaluate((element) => { element.scrollTop -= 100; });
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toHaveCount(0);
});

test('protects touch reading through live updates', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  const bounds = (await timeline.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const settled = timeline.evaluate((element) => new Promise<void>((resolve) => element.addEventListener('scrollend', () => resolve(), { once: true })));
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 50;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const offset of [35, 75, 120, 180]) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + offset }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  expect(await bottomDistance(timeline)).toBeGreaterThan(64);
  await settled;
  const top = await timeline.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  await session.detach();
});

test('lets a touch swipe settle at the bottom without corrective scroll writes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(1);
  await timeline.evaluate(element => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true }));
    element.scrollTop -= 250;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
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
  const bounds = (await timeline.boundingBox())!;
  const x = bounds.x + bounds.width / 4;
  const y = bounds.y + bounds.height - 40;
  const session = await page.context().newCDPSession(page);
  try {
    const settled = timeline.evaluate(element => new Promise<void>(resolve => element.addEventListener('scrollend', () => resolve(), { once: true })));
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const offset of [30, 65, 110, 160, 220, 280, 340]) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - offset }] });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settled;
    await expect.poll(() => bottomDistance(timeline)).toBeLessThan(1);
    expect(await timeline.evaluate(element => (element as HTMLElement & { scrollWrites: number[] }).scrollWrites)).toEqual([]);
    await page.getByRole('button', { name: 'Append live' }).click();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThan(1);
  } finally { await session.detach(); }
});

test('protects reading after dragging the scrollbar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await page.addStyleTag({ content: '.lab-timeline-scroll::-webkit-scrollbar { width: 16px; } .lab-timeline-scroll::-webkit-scrollbar-thumb { background: gray; }' });
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  const bounds = (await timeline.boundingBox())!;
  const settled = timeline.evaluate((element) => new Promise<void>((resolve) => element.addEventListener('scrollend', () => resolve(), { once: true })));
  await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height - 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await settled;
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const top = await timeline.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
});

test('keeps an earlier control in view when reached with Tab', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Switch Agent' }).focus();
  await page.keyboard.press('Tab');
  await expect(timeline).toBeFocused();
  await page.keyboard.press('Tab');
  const load = page.getByRole('button', { name: 'Load earlier activity' });
  await expect(load).toBeFocused();
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await expect.poll(() => load.evaluate((element) => {
    const control = element.getBoundingClientRect();
    const viewport = element.closest('.lab-timeline-scroll')!.getBoundingClientRect();
    return control.top >= viewport.top && control.bottom <= viewport.bottom;
  })).toBe(true);
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeGreaterThan(64);
});

test('restores the reading position across hidden Trace and follows after epoch or Agent replacement', async ({ page }) => {
  const timeline = page.getByTestId('timeline');
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await timeline.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const before = await timeline.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Toggle Trace' }).click();
  await page.getByRole('button', { name: 'Append live' }).click();
  await page.getByRole('button', { name: 'Toggle Trace' }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  await page.getByRole('button', { name: 'Replace epoch' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
  await timeline.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch Agent' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(3);
});

test('folds the input into a bottom tab while preserving the draft and reading position', async ({ page }, testInfo) => {
  const timeline = page.getByTestId('timeline');
  const input = page.getByTestId('prompt-input');
  const hide = page.getByRole('button', { name: 'Hide message input', exact: true });
  await input.fill('Continue reviewing later');
  const expandedHeight = (await timeline.boundingBox())!.height;
  await hide.click();
  await expect(input).toBeHidden();
  const show = page.getByRole('button', { name: 'Show message input', exact: true });
  await expect(show).toBeVisible();
  await expect.poll(async () => (await timeline.boundingBox())!.height).toBeGreaterThan(expandedHeight);
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(1);
  await page.getByRole('button', { name: 'Append live' }).click();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('input-collapsed.png') });
  await show.click();
  await expect(input).toHaveValue('Continue reviewing later');
  await expect(input).toBeVisible();
  await expect.poll(() => bottomDistance(timeline)).toBeLessThan(1);
  await timeline.hover();
  await page.mouse.wheel(0, -400);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const anchor = await visibleAnchor(timeline);
  for (const toggle of [hide, show]) {
    await toggle.click();
    await expect.poll(() => timeline.evaluate((element, saved) => {
      const entry = [...element.querySelectorAll<HTMLElement>('[data-entry-key]')].find(node => node.dataset.entryKey === saved.key)!;
      return entry.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
    }, anchor)).toBeCloseTo(0, 0);
  }
  await expect(input).toHaveValue('Continue reviewing later');
  await page.screenshot({ path: testInfo.outputPath('input-expanded.png') });
});

async function bottomDistance(timeline: Locator): Promise<number> {
  return timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}
async function visibleAnchor(timeline: Locator): Promise<{ key: string; offset: number }> {
  return timeline.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const entry = Array.from(element.querySelectorAll<HTMLElement>('[data-entry-key]')).find((node) => node.getBoundingClientRect().bottom > bounds.top)!;
    return { key: entry.dataset.entryKey!, offset: entry.getBoundingClientRect().top - bounds.top };
  });
}
