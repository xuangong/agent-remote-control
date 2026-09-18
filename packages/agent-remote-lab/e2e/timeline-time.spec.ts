import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ locale: 'en-GB', timezoneId: 'Asia/Shanghai' });

async function drag(page: Page, target: Locator, dx: number, dy = 0, release = true) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Swipe target is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(32, box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
  }
  if (release) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return cdp;
}

test('reveals local timestamps in the sender direction without changing row height', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Touch gesture');
  await page.goto('/e2e/fixtures/timeline-time.html');
  const user = page.locator('[data-entry-key="time:codex:1:user"]');
  const assistant = page.locator('[data-entry-key="time:codex:2:assistant"]');
  const rowHeight = (await assistant.boundingBox())!.height;
  for (const [row, dx] of [[user, -120], [assistant, 120]] as const) {
    await drag(page, row.locator('.agent-message'), dx);
    const time = row.locator('time');
    await expect(time).toBeVisible();
    await expect(time).toContainText('18/09/2026');
    await expect(time).toContainText('10:11:17');
    await expect(time).toHaveAttribute('datetime', '2026-09-18T02:11:17.158Z');
    expect(Math.abs((await assistant.boundingBox())!.height - rowHeight)).toBeLessThan(0.1);
    await page.screenshot({ path: testInfo.outputPath(dx < 0 ? 'user-time.png' : 'assistant-time.png') });
    await expect(time).toBeHidden({ timeout: 4000 });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keeps vertical scrolling, opposite swipes, links and code scrolling available', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch gesture');
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/e2e/fixtures/timeline-time.html');
  const user = page.locator('[data-entry-key="time:codex:1:user"]');
  const assistant = page.locator('[data-entry-key="time:codex:2:assistant"]');
  await drag(page, user, 100);
  await expect(user.locator('time')).toBeHidden();
  await drag(page, assistant, -100);
  await expect(assistant.locator('time')).toBeHidden();
  const code = assistant.locator('pre');
  await drag(page, code, -120);
  await expect.poll(() => code.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(assistant.locator('time')).toBeHidden();
  await assistant.getByRole('link', { name: 'Open details' }).tap();
  await expect(page).toHaveURL(/#details$/);
  const scroll = page.getByTestId('scroll');
  await drag(page, assistant, 5, -100);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(30);
  await expect(assistant.locator('time')).toBeHidden();
  expect(errors).toEqual([]);
});

test('cancels interrupted gestures and does not swipe desktop entries', async ({ page, isMobile }) => {
  await page.goto('/e2e/fixtures/timeline-time.html');
  const assistant = page.locator('[data-entry-key="time:codex:2:assistant"]');
  if (isMobile) {
    const cdp = await drag(page, assistant, 100, 0, false);
    await expect(assistant.locator('time')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(assistant.locator('time')).toBeHidden();
  } else {
    const box = (await assistant.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 30);
    await page.mouse.up();
    await expect(assistant.locator('time')).toBeHidden();
  }
  await expect(page.getByText('Runtime notice')).toHaveCount(0);
  await expect(page.getByText('Wait up to 15 seconds (requested)', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-entry-key="time:codex:4:invalid"] time')).toHaveCount(0);
});

test('reveals tool time without activating its disclosure', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch gesture');
  await page.goto('/e2e/fixtures/timeline-time.html');
  const row = page.locator('[data-entry-key="time:codex:3:sleep"]');
  const toggle = row.locator('.agent-tool-toggle');
  await drag(page, toggle, 120);
  await expect(row.locator('time')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test.describe('local calendar date', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('uses the device timezone across a date boundary', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Touch gesture');
    await page.goto('/e2e/fixtures/timeline-time.html');
    const row = page.locator('[data-entry-key="time:codex:1:user"]');
    await drag(page, row, -120);
    await expect(row.locator('time')).toContainText('17/09/2026');
    await expect(row.locator('time')).toContainText('19:11:17');
  });
});
