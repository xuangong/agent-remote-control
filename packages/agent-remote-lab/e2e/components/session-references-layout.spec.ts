import { expect, test, type Locator } from '@playwright/test';

/** On a phone only the Side shows: two panes would not fit beside each other. */
const fixture = (kind: 'snapshot' | 'reference', width = 440, only = false, extra = '') => `/e2e/fixtures/session-references-layout.html?kind=${kind}&width=${width}${only ? '&only=side' : ''}${extra}`;
const box = async (locator: Locator) => (await locator.boundingBox())!;

test('a fork lists its copied context above its composer, and opening it leaves the composer where it was', async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 390 : 1100, height: 844 });
  await page.goto(fixture('snapshot', isMobile ? 360 : 440, isMobile));
  const side = page.getByRole('region', { name: 'side', exact: true });
  const source = page.getByRole('region', { name: 'source', exact: true });
  const summary = side.locator('.lab-fork-reference summary');
  await expect(summary).toBeVisible();
  const composer = side.locator('.agent-composer');
  // A position is read inside its pane, whatever the page scroll.
  const place = async () => { const inner = await box(composer), outer = await box(side); return { x: inner.x - outer.x, y: inner.y - outer.y, width: inner.width, height: inner.height }; };
  const before = await box(composer);
  const placed = await place();
  const reference = await box(side.locator('.lab-fork-reference'));
  expect(reference.y + reference.height).toBeLessThanOrEqual(before.y + 1);
  // Beside a source with no reference, the composer stands at the same height and the same line.
  if (!isMobile) {
    const sourceComposer = await box(source.locator('.agent-composer'));
    expect(Math.abs(sourceComposer.height - before.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(sourceComposer.y - before.y)).toBeLessThanOrEqual(1);
  }
  await summary.click();
  await expect(side.getByText('Later source messages are not included.')).toBeVisible();
  expect(await place()).toEqual(placed);
  await summary.click();
  expect(await place()).toEqual(placed);
});

test('the source reference of a Side starts at the composer edge, in one compact line clear of the collapse tab', async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 390 : 1100, height: 844 });
  await page.goto(fixture('reference', isMobile ? 360 : 440, isMobile));
  const side = page.getByRole('region', { name: 'side', exact: true });
  const references = side.locator('.lab-session-refs');
  await expect(references.locator('.lab-session-ref[data-origin="source"]')).toHaveCount(1);
  const offset = async () => Math.abs((await box(references.locator(':scope > :first-child'))).x - (await box(side.locator('.agent-composer'))).x);
  await expect.poll(offset).toBeLessThanOrEqual(1);
  const row = await box(references), composer = await box(side.locator('.agent-composer'));
  const add = await box(side.locator('.lab-session-ref-add')), tab = await box(side.locator('.lab-composer-toggle'));
  expect(Math.abs(row.y + row.height - composer.y)).toBeLessThanOrEqual(1);
  expect(row.height).toBeLessThanOrEqual(isMobile ? 36 : 28);
  expect(add.x + add.width).toBeLessThanOrEqual(tab.x);
  if (isMobile) return;
  // A pane wider than the composer centres it; the references follow it.
  await side.locator('.lab-composer-dock').evaluate(node => { (node as HTMLElement).style.width = '1300px'; });
  await expect.poll(async () => (await box(side.locator('.agent-composer'))).x - (await box(side)).x).toBeGreaterThan(100);
  await expect.poll(offset).toBeLessThanOrEqual(1);
});

test('the session picker of a Side fits a short visible area: inside the session, above its references, with its title, filter and Cancel in view and the sessions scrolling', async ({ page, isMobile }) => {
  // A touch keyboard leaves about 460 px of height; the pane fills it.
  await page.setViewportSize({ width: isMobile ? 390 : 1100, height: 460 });
  await page.goto(fixture('reference', isMobile ? 360 : 440, isMobile, '&picking&height=460'));
  const side = page.getByRole('region', { name: 'side', exact: true });
  const picker = side.getByRole('dialog', { name: 'Reference a session', exact: true });
  await expect(picker.getByRole('button', { name: /^Listed session 1\b/ })).toBeVisible();
  const references = side.locator('.lab-session-refs');
  const pickerTop = async () => (await box(picker)).y - (await box(side.locator('.lab-workbench-layout').first())).y;
  await expect.poll(pickerTop).toBeGreaterThanOrEqual(0);
  const placed = await box(picker);
  expect(placed.y + placed.height).toBeLessThanOrEqual((await box(references)).y);
  for (const control of [picker.getByText('Reference a session', { exact: true }), picker.getByRole('searchbox'), picker.getByRole('button', { name: 'Cancel', exact: true })]) await expect(control).toBeInViewport({ ratio: 1 });
  expect(await picker.locator('ul').evaluate(list => { list.scrollTop = list.scrollHeight; return list.scrollHeight > list.clientHeight && list.scrollTop === list.scrollHeight - list.clientHeight; })).toBe(true);
});
