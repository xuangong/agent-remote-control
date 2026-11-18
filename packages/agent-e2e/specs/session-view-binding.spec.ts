import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';
import { openSessionsPage } from './all-sessions';

async function setup(page: Page) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto('/'); await showNewSession(page); await page.getByTestId('session-create').click();
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
  // The composer accepts a draft while the session opens, then hides for a moment as it attaches; wait until it is ready.
  await expect(page.locator('.lab-primary-conversation').getByLabel('Agent activity', { exact: true })).toContainText('Ready');
  await expect(page).toHaveURL(/[?&]session=/);
  const address = page.url(), providerId = new URL(address).searchParams.get('provider')!;
  const targets = await page.evaluate(async providerId => {
    const create = async (title: string) => {
      const result = await fetch('/v1/remote/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId, operationId: crypto.randomUUID() }) });
      if (!result.ok) throw new Error(await result.text());
      return { ...await result.json() as { agentId: string; nativeSessionId: string }, providerId, title, state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    };
    return [await create('Window alpha'), await create('Window beta')];
  }, providerId);
  await page.route('**/v1/remote/catalog?*', route => route.fulfill({ json: { items: targets, hasMore: false, revision: 'views' } }));
  return { address, targets };
}
async function choose(page: Page, name: string) {
  const list = (await openSessionsPage(page)).getByRole('region', { name: 'Discover sessions', exact: true });
  await list.getByRole('button', { name: 'Refresh', exact: true }).click();
  await list.locator('.lab-session-row').filter({ hasText: name }).click();
}

test('a restored bound view keeps its draft while attachment fails, and recovers on Retry', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Creation belongs to the wide workspace.');
  const { targets } = await setup(page);
  await page.locator('.lab-session-dock-add').click(); await choose(page, 'Window alpha');
  const view = page.locator('.lab-bindable-session-window[data-view-id]');
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expect(view.locator('.agent-message-user')).toContainText('Recorded history 1');
  await view.getByTestId('prompt-input').fill('Draft while reconnecting');
  let fail = true;
  await page.route('**/v1/remote/attach', route => fail && route.request().postDataJSON().nativeSessionId === targets[0]!.nativeSessionId
    ? route.fulfill({ status: 503, json: { error: 'Cached host is offline' } }) : route.continue());
  await page.reload();
  await expect(view.getByRole('alert')).toContainText('Cached host is offline');
  await expect(view.getByTestId('prompt-input')).toContainText('Draft while reconnecting');
  fail = false; await view.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expect(view.getByTestId('prompt-input')).toContainText('Draft while reconnecting');
});

// Since Windows (976f29f0, docs/superpowers/specs/2026-10-15-window-workspaces-design.md), an additional view of a session gets its own draft owner.
test('two ordinary views of the same session keep their own drafts and reuse its live connection', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Independent views require the wide workspace.');
  const { address, targets } = await setup(page);
  const nativeSessionId = new URL(address).searchParams.get('session')!;
  const main = page.locator('.lab-primary-conversation');
  await main.getByTestId('prompt-input').fill('Shared session draft');
  await page.route('**/v1/remote/catalog?*', route => route.fulfill({ json: { items: [{ ...targets[0], nativeSessionId, title: 'New session' }], hasMore: false, revision: 'shared' } }));
  const attachments: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/attach')) attachments.push(request.url()); });
  await page.locator('.lab-session-dock-add').click(); await choose(page, 'New session');
  const view = page.locator('.lab-bindable-session-window[data-view-id]');
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expect(view.getByTestId('prompt-input')).toHaveText('');
  await view.getByTestId('prompt-input').fill('Changed from the second view');
  await expect(view.getByTestId('prompt-input')).toHaveText('Changed from the second view');
  await expect(main.getByTestId('prompt-input')).toHaveText('Shared session draft');
  expect(attachments).toEqual([]);
  await view.getByRole('button', { name: 'Close New session', exact: true }).click();
  await expect(main.getByTestId('prompt-input')).toBeEnabled();
});
