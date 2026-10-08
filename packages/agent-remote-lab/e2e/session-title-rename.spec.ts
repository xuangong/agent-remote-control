import { expect, test, type Page } from '@playwright/test';

test.beforeEach(({ isMobile }) => { test.skip(isMobile, 'Touch double-click follows native browser behavior.'); });

async function openSession(page: Page, mode = 'enabled', starred = false) {
  const requests: { providerId: string; nativeSessionId: string; title: string; operationId: string }[] = [];
  let title = 'Research notes';
  let rejectNext = false;
  await page.route('**/v1/favorites', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { revision: 1, folders: [], stars: starred ? [{
      favoriteId: 'research', folderId: null, order: 0, hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session',
      title, starredAt: 1, available: true, online: true, canRename: true,
    }] : [] } });
  });
  await page.route('**/v1/remote/hosts/host/session/rename', async route => {
    requests.push(route.request().postDataJSON());
    if (rejectNext) {
      rejectNext = false;
      return route.fulfill({ status: 503, json: { error: 'The native name could not be confirmed.' } });
    }
    title = requests.at(-1)!.title.trim();
    return route.fulfill({ json: { title } });
  });
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.goto(`/e2e/fixtures/session-stars.html?rename=${mode}`);
  const close = page.getByRole('button', { name: 'Close Context', exact: true });
  if (await close.isVisible()) await close.click();
  const heading = page.locator('.lab-primary-title');
  await expect(heading).toBeVisible();
  if (mode === 'enabled') await expect(heading).toHaveAttribute('role', 'button');
  return { heading, requests, rejectNext: () => { rejectNext = true; } };
}

for (const starred of [false, true]) {
  test(`double-click renames the main session${starred ? ' in favorites' : ' without adding a favorite'}`, async ({ page }) => {
    const { heading, requests } = await openSession(page, 'enabled', starred);
    const dialog = page.getByRole('dialog', { name: 'Rename session', exact: true });
    await heading.click();
    await expect(dialog).toHaveCount(0);
    await heading.dblclick();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Research notes');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await heading.focus();
    await heading.press('F2');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('  Renamed research  ');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(heading).toHaveText('Renamed research');
    await expect(page).toHaveTitle('Renamed research · Agent Remote Control');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ providerId: 'recorded', nativeSessionId: 'recorded-session', title: 'Renamed research' });
    expect(requests[0]!.operationId).toBeTruthy();
  });
}

test('rename failure retains the name and retries the same operation', async ({ page }) => {
  const { heading, requests, rejectNext } = await openSession(page);
  rejectNext();
  await heading.dblclick();
  const dialog = page.getByRole('dialog', { name: 'Rename session', exact: true });
  const input = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await input.fill('Retry research');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('The native name could not be confirmed.');
  await expect(input).toHaveValue('Retry research');
  await expect(heading).toHaveText('Research notes');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(heading).toHaveText('Retry research');
  expect(requests).toHaveLength(2);
  expect(requests[1]!.operationId).toBe(requests[0]!.operationId);
});

for (const mode of ['unsupported', 'offline']) {
  test(`does not offer title editing when the Host is ${mode}`, async ({ page }) => {
    const { heading, requests } = await openSession(page, mode);
    await expect(heading).not.toHaveAttribute('role', 'button');
    await heading.dblclick();
    await expect(page.getByRole('dialog', { name: 'Rename session', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(0);
  });
}
