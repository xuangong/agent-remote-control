import { expect, test, type Locator, type Page } from '@playwright/test';

const base = { hostId: 'host', providerId: 'recorded', title: 'Same session title', starredAt: 1, available: true, online: true, hostName: 'Work Mac' };
async function setup(page: Page, title = base.title) {
  let stars = ['first', 'second'].map((nativeSessionId, order) => ({ ...base, title, nativeSessionId, favoriteId: `favorite-${nativeSessionId}`, folderId: null, order }));
  let revision = 0;
  const removed: string[] = [];
  await page.route('**/v1/favorites', route => {
    if (route.request().method() === 'POST') {
      const command = route.request().postDataJSON();
      expect(command.type).toBe('remove-session');
      expect(command.revision).toBe(revision);
      const { nativeSessionId } = command.session;
      removed.push(nativeSessionId);
      stars = stars.filter(item => item.nativeSessionId !== nativeSessionId);
      revision++;
    }
    return route.fulfill({ json: { stars, folders: [], revision } });
  });
  await page.route('**/auth/status', route => route.fulfill({ json: {
    basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 120000,
    user: { id: 'alice', name: 'Alice Example' },
  } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: route.request().postDataJSON().nativeSessionId } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?gateway=1');
  return { removed };
}

async function favoriteAction(page: Page, row: Locator, action: 'Track' | 'Untrack' | 'Remove favorite') {
  await row.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
}

test('aligns the desktop account and keeps long favorite titles on one line with reachable actions', async ({ page }, testInfo) => {
  await setup(page, '关闭所有agent-remote-controller进程并检查每个会话的状态');
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  else {
    const view = page.getByRole('button', { name: 'View options', exact: true });
    await view.click();
    const options = page.getByRole('region', { name: 'View options', exact: true });
    await options.getByText('Header', { exact: true }).click();
    await options.press('Escape');
    const header = page.locator('.lab-app-bar');
    const identity = header.getByLabel('Gateway account', { exact: true });
    const security = header.getByRole('button', { name: 'Security', exact: true });
    await expect(identity).toBeVisible();
    const a = (await identity.boundingBox())!, b = (await security.boundingBox())!;
    expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
    await expect(page.locator('#lab-context').getByRole('button', { name: 'Security', exact: true })).toHaveCount(0);
    await page.locator('#lab-context').getByRole('button', { name: 'Favorites', exact: true }).click();
  }
  const tree = page.locator(mobile ? '.lab-title-favorites' : '#lab-context').getByRole('tree', { name: 'Favorites folders and sessions', exact: true });
  const row = tree.getByRole('treeitem').first();
  const title = row.locator('strong'), actions = row.getByRole('button', { name: /^Actions for / });
  await expect(title).toBeVisible();
  await expect(title).toHaveText('关闭所有agent-remote-controller进程并检查每个会话的状态');
  const a = (await row.boundingBox())!, b = (await actions.boundingBox())!;
  expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
  expect(b.x + b.width).toBeLessThanOrEqual(a.x + a.width);
  await favoriteAction(page, row, 'Track');
  await expect(row.getByLabel('Tracked on this device', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(title).toHaveCSS('white-space', 'nowrap');
  await page.screenshot({ path: testInfo.outputPath('favorites-layout.png') });
});

test('untracks and unstars only the chosen identity when session titles are identical', async ({ page }, testInfo) => {
  const { removed } = await setup(page);
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  else await page.locator('#lab-context').getByRole('button', { name: 'Favorites', exact: true }).click();
  const tree = page.locator(mobile ? '.lab-title-favorites' : '#lab-context').getByRole('tree', { name: 'Favorites folders and sessions', exact: true });
  const first = tree.locator('[data-favorite-id="favorite-first"]'), second = tree.locator('[data-favorite-id="favorite-second"]');
  for (const row of [first, second]) await favoriteAction(page, row, 'Track');
  const tracked = () => page.evaluate(() => JSON.parse(localStorage.getItem(`agent-remote-tracking:${location.origin}/u/alice/`) ?? '[]').map((item: { nativeSessionId: string }) => item.nativeSessionId));
  await expect.poll(tracked).toEqual(['first', 'second']);
  await favoriteAction(page, second, 'Untrack');
  await expect.poll(tracked).toEqual(['first']);
  await expect(first.getByLabel('Tracked on this device', { exact: true })).toBeVisible();
  await expect(second.getByLabel('Tracked on this device', { exact: true })).toHaveCount(0);
  await favoriteAction(page, second, 'Remove favorite');
  await expect.poll(() => removed).toEqual(['second']);
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(first).toBeVisible();
  await expect.poll(tracked).toEqual(['first']);
});
