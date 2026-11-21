import { expect, test } from '@playwright/test';

// The touch minimum is 44 px. The composer's stop button is drawn at 32 px; under a coarse pointer
// its target, which stops a running turn, must still meet the minimum.
test('Interrupt meets the 44 px touch minimum while a turn runs', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The touch minimum applies to coarse pointers.');
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  const interrupt = page.getByTestId('cancel-submit');
  await expect(interrupt).toBeVisible();
  const bounds = (await interrupt.boundingBox())!;
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.width).toBeGreaterThanOrEqual(44);
});

test('every control a person answers or opens with a finger is at least 44 px', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The touch minimum applies to coarse pointers.');
  await page.goto('/e2e/fixtures/touch-targets.html');
  await expect(page.getByRole('button', { name: 'Load resource' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download resource' })).toBeVisible();
  const targets = await page.evaluate(() => {
    const selector = '.agent-interaction :is(button, a, summary, label), .orchard-approval :is(button, summary), .agent-resources :is(button, a)';
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length > 0).map(node => {
      const box = node.getBoundingClientRect();
      return { name: (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 40), width: Math.round(box.width), height: Math.round(box.height) };
    });
  });
  // Something was measured for every kind of card, so a selector that stops matching cannot pass this unnoticed.
  for (const name of ['Load resource', 'Download', 'Stable (Recommended)', 'Submit response', 'Allow', 'Not now', 'I have completed this']) {
    expect(targets.some(target => target.name.includes(name)), name).toBe(true);
  }
  expect(targets.filter(target => target.height < 44 || target.width < 44)).toEqual([]);
});

test('the shell controls of a compact layout, Open sessions, View options and Close Context, are at least 44 px', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The touch minimum applies to coarse pointers.');
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
  const open = page.getByRole('button', { name: 'Open sessions', exact: true });
  const view = page.getByRole('button', { name: 'View options', exact: true });
  await open.click();
  const close = page.getByRole('dialog', { name: 'Context', exact: true }).getByRole('button', { name: 'Close Context', exact: true });
  for (const control of [close]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await close.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await close.click();
  for (const control of [open, view]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height), await control.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
  }
});
