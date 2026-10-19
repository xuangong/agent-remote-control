import { expect, test, type Locator, type Page } from '@playwright/test';

const names = ['Primary', 'Primary child', 'Primary leaf', 'Dock', 'Dock child', 'Dock leaf'];
const fixture = '/e2e/fixtures/session-family-resize.html';
const pane = (page: Page, name: string) => page.locator(`.lab-session-family-pane[aria-label="${name}"]`);
const width = async (element: Locator) => (await element.boundingBox())!.width;
async function widths(page: Page) {
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await width(pane(page, name))])));
}
async function expectAdjacentPanes(page: Page) {
  const boxes = await Promise.all(names.map(name => pane(page, name).boundingBox()));
  for (let index = 0; index < boxes.length - 1; index++) {
    const left = boxes[index]!, right = boxes[index + 1]!;
    const gap = right.x - left.x - left.width;
    expect(gap, `${names[index + 1]} must follow ${names[index]} without overlap`).toBeGreaterThanOrEqual(-1);
    expect(gap, `${names[index + 1]} must stay next to ${names[index]}`).toBeLessThanOrEqual(6);
  }
}
async function resize(page: Page, name: string, delta: number) {
  const separator = page.getByRole('separator', { name: `${name} width`, exact: true });
  await separator.scrollIntoViewIfNeeded();
  const before = await widths(page);
  const edge = (await separator.boundingBox())!;
  const left = (await pane(page, name).boundingBox())!;
  expect(Math.abs(edge.x + edge.width / 2 - left.x - left.width), `${name} handle belongs at its own right boundary`).toBeLessThanOrEqual(6);
  const x = edge.x + edge.width / 2, y = edge.y + Math.min(220, edge.height / 2);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="separator"]')?.getAttribute('aria-label'), { x, y }))
    .toBe(`${name} width`);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  // The session itself must track the pointer before the shared layout is committed.
  await expect.poll(() => width(pane(page, name))).toBeCloseTo(before[name]! + delta, 0);
  for (const other of names.filter(value => value !== name)) expect(await width(pane(page, other)), `${other} width during ${name} resize`).toBeCloseTo(before[other]!, 0);
  await expectAdjacentPanes(page);
  await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', String(Math.round(before[name]! + delta)));
  await expect.poll(() => width(pane(page, name))).toBeCloseTo(before[name]! + delta, 0);
  for (const other of names.filter(value => value !== name)) expect(await width(pane(page, other)), `${other} width after ${name} resize`).toBeCloseTo(before[other]!, 0);
  await expectAdjacentPanes(page);
}

for (const family of ['Primary', 'Dock']) {
  test(`${family} family resizes every session at its own boundary and restores widths`, async ({ page, isMobile }, testInfo) => {
    test.skip(isMobile, 'Wide layouts use pointer resize handles.');
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1760, height: 900 });
    await page.goto(fixture);
    await expect(page.getByRole('separator')).toHaveCount(6);
    for (const [name, delta] of [[family, 44], [`${family} child`, 36], [`${family} leaf`, 28]] as const) await resize(page, name, delta);
    const saved = await widths(page);
    await page.reload();
    await expect(page.getByRole('separator')).toHaveCount(6);
    for (const name of names) await expect.poll(() => width(pane(page, name))).toBeCloseTo(saved[name]!, 0);
    const leaf = page.getByRole('separator', { name: `${family} leaf width`, exact: true });
    await leaf.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`${family.toLowerCase()}-family-resized.png`) });
    expect(errors).toEqual([]);
  });
}

test('a dock with no remaining children uses the same minimum width as every window pane', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Wide layouts expose keyboard resize handles.');
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto(fixture);
  await expect(page.getByRole('separator')).toHaveCount(6);
  await pane(page, 'Dock child').getByRole('button', { name: 'Close subagent', exact: true }).click();
  await expect(pane(page, 'Dock child')).toHaveCount(0);
  await expect(pane(page, 'Dock leaf')).toHaveCount(0);
  for (const name of ['Primary', 'Primary child', 'Primary leaf', 'Dock']) {
    const separator = page.getByRole('separator', { name: `${name} width`, exact: true });
    await separator.focus();
    await separator.press('Home');
    await expect(separator).toHaveAttribute('aria-valuenow', '240');
    await expect.poll(() => width(pane(page, name))).toBe(240);
  }
  await expect.poll(() => width(page.getByRole('region', { name: 'Docked Dock', exact: true }))).toBe(240);
});

test('one primary family can scroll to every child without another dock', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Wide layouts expose the horizontal pane rail.');
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto(`${fixture}?primary-only`);
  await expect(page.getByRole('separator')).toHaveCount(3);
  await expect(page.locator('.lab-session-dock-pane')).toHaveCount(0);
  const rail = page.locator('.lab-session-dock-rail');
  await rail.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBeGreaterThan(400);
  const viewport = (await rail.boundingBox())!, leaf = (await pane(page, 'Primary leaf').boundingBox())!;
  expect(leaf.x + leaf.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
  const separator = page.getByRole('separator', { name: 'Primary leaf width', exact: true });
  const edge = (await separator.boundingBox())!, x = edge.x + edge.width / 2, y = edge.y + 200;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="separator"]')?.getAttribute('aria-label'), { x, y }))
    .toBe('Primary leaf width');
});

test('the window rail owns pane scrolling while Markdown content scrolls independently', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Wide layouts have a horizontal window rail.');
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto(`${fixture}?content`);
  await expect(page.getByRole('separator')).toHaveCount(6);
  const rail = page.locator('.lab-session-dock-rail');
  const families = page.locator('.lab-session-family');
  for (const family of await families.all()) {
    const metrics = await family.evaluate(element => {
      element.scrollLeft = 100;
      return { label: element.getAttribute('aria-label'), client: element.clientWidth, scroll: element.scrollWidth,
        left: element.scrollLeft, overflow: getComputedStyle(element).overflowX };
    });
    expect(metrics.scroll, `${metrics.label} must fit its pane group`).toBeLessThanOrEqual(metrics.client);
    expect(['auto', 'scroll'], `${metrics.label} must not own pane scrolling`).not.toContain(metrics.overflow);
    expect(metrics.left, `${metrics.label} must not move independently of the window`).toBe(0);
  }
  await rail.evaluate(element => { element.scrollLeft = 0; });
  const primary = pane(page, 'Primary');
  for (const selector of ['.agent-markdown-table', '.agent-markdown pre']) {
    const content = primary.locator(selector);
    await expect(content).toBeVisible();
    await content.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect.poll(() => content.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await rail.evaluate(element => element.scrollLeft)).toBe(0);
  }
  await rail.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const edge = (await rail.boundingBox())!, leaf = (await pane(page, 'Dock leaf').boundingBox())!;
  expect(leaf.x + leaf.width).toBeLessThanOrEqual(edge.x + edge.width + 1);
  await page.screenshot({ path: testInfo.outputPath('window-scroll-owner.png') });
});

test('a floating family keeps its own scrolling to reach attached sessions', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Wide layouts allow floating session families.');
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto(fixture);
  await expect(page.getByRole('separator')).toHaveCount(6);
  await page.getByRole('button', { name: 'Float Dock', exact: true }).click();
  await expect(page.locator('.lab-session-dock-pane')).toHaveCount(0);
  const family = page.locator('.lab-bindable-session-window[data-view-id="dock"] .lab-session-family');
  await expect(family).toBeVisible();
  await family.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => family.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const viewport = (await family.boundingBox())!, leaf = (await pane(page, 'Dock leaf').boundingBox())!;
  expect(leaf.x).toBeGreaterThanOrEqual(viewport.x);
  expect(leaf.x + leaf.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
  // Invoke the placement action without scrolling its root control into view first.
  await page.getByRole('button', { name: 'Dock Dock', exact: true }).dispatchEvent('click');
  await expect(page.locator('.lab-session-dock-pane')).toHaveCount(1);
  await expect.poll(() => family.evaluate(element => element.scrollLeft)).toBe(0);
  const parent = (await page.locator('.lab-session-dock-pane').boundingBox())!, root = (await pane(page, 'Dock').boundingBox())!;
  expect(Math.abs(root.x - parent.x)).toBeLessThanOrEqual(1);
});

test('narrow presentation cancels a resize and removes handles without horizontal overflow', async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto(fixture);
  await expect(page.getByRole('separator')).toHaveCount(6);
  const original = await widths(page);
  const separator = page.getByRole('separator', { name: 'Primary width', exact: true });
  await separator.scrollIntoViewIfNeeded();
  const edge = (await separator.boundingBox())!, x = edge.x + edge.width / 2, y = edge.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 8 });
  await expect.poll(() => width(pane(page, 'Primary'))).toBe(480);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('separator')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('.lab-session-dock-pane')).toHaveCount(0);
  await expect(pane(page, 'Primary')).toBeVisible();
  await expect(page.locator('.lab-session-family-pane:visible')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1760, height: 900 });
  await expect(page.getByRole('separator')).toHaveCount(6);
  for (const name of names) await expect.poll(() => width(pane(page, name))).toBe(original[name]);
  expect(await page.locator('[data-session-family-shell]').evaluateAll(elements => elements.map(element =>
    (element as HTMLElement).style.getPropertyValue('--lab-session-family-root-width')))).toEqual(['', '']);
});
