import { expect, test, type Page } from '@playwright/test';

const base = { hostId: 'host', providerId: 'recorded', title: 'Same session title', starredAt: 1, available: true, online: true, hostName: 'Work Mac' };
async function setup(page: Page, title = base.title) {
  let stars = ['first', 'second'].map(nativeSessionId => ({ ...base, title, nativeSessionId }));
  const removed: string[] = [];
  await page.route('**/v1/stars', route => {
    if (route.request().method() === 'DELETE') {
      const { nativeSessionId } = route.request().postDataJSON();
      removed.push(nativeSessionId);
      stars = stars.filter(item => item.nativeSessionId !== nativeSessionId);
    }
    return route.fulfill({ json: { stars } });
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

test('aligns the desktop account and keeps long favorites on one horizontally scrollable row', async ({ page }, testInfo) => {
  await setup(page, '关闭所有agent-remote-controller进程并检查每个会话的状态');
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  else {
    const identity = page.locator('.gateway-account-actions .gateway-account-identity');
    const security = page.locator('.gateway-account-actions').getByRole('button', { name: 'Security', exact: true });
    await expect(identity).toBeVisible();
    const a = (await identity.boundingBox())!, b = (await security.boundingBox())!;
    expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
    await expect(page.locator('.lab-sidebar-account')).toBeHidden();
  }
  const list = page.locator(mobile ? '.lab-title-favorites .lab-favorite-list' : '#lab-context [aria-label="Favorites"] .lab-favorite-list');
  const row = list.locator('li').first();
  const title = row.locator('strong'), track = row.getByRole('button', { name: /^(?:Untrack|Track) / });
  await expect(title).toBeVisible();
  const a = (await title.boundingBox())!, b = (await track.boundingBox())!;
  expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
  expect(await list.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await list.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await track.click();
  await expect(track).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await list.evaluate(element => { element.scrollLeft = 0; });
  await expect(title).toHaveCSS('white-space', 'nowrap');
  await page.screenshot({ path: testInfo.outputPath('favorites-layout.png') });
});

test('untracks and unstars only the chosen identity when session titles are identical', async ({ page }, testInfo) => {
  const { removed } = await setup(page);
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  const list = page.locator(mobile ? '.lab-title-favorites .lab-favorite-list' : '#lab-context [aria-label="Favorites"] .lab-favorite-list');
  for (const index of [0, 1]) await list.locator('li').nth(index).getByRole('button', { name: 'Track Same session title', exact: true }).click();
  const tracked = () => page.evaluate(() => JSON.parse(localStorage.getItem(`agent-remote-tracking:${location.origin}/u/alice/`) ?? '[]').map((item: { nativeSessionId: string }) => item.nativeSessionId));
  expect(await tracked()).toEqual(['first', 'second']);
  await list.locator('li').last().getByRole('button', { name: 'Untrack Same session title', exact: true }).click();
  expect(await tracked()).toEqual(['first']);
  await expect(list.locator('li').first().getByRole('button', { name: 'Untrack Same session title', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await list.locator('li').last().getByRole('button', { name: 'Unstar Same session title', exact: true }).click();
  expect(removed).toEqual(['second']);
  await expect(list.locator('li')).toHaveCount(1);
  expect(await tracked()).toEqual(['first']);
});
