import { clickSessionAction, showSessionAction } from './session-actions';
import { expect, test, type Page } from '@playwright/test';
import { showNewSession, showSessions } from './session-navigation';

async function setup(page: Page) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto('/'); await showNewSession(page); await page.getByTestId('session-create').click();
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
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
  await showSessions(page);
  await page.locator('.lab-sidebar-tabs').getByRole('button', { name: 'Sessions', exact: true }).click();
  const list = page.getByRole('region', { name: 'Discover sessions', exact: true });
  await list.getByRole('button', { name: 'Refresh', exact: true }).click();
  await list.locator('.lab-session-row').filter({ hasText: name }).click();
}

test('empty views bind and replace sessions without changing main, placement or drafts', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Creation belongs to the wide workspace.');
  const { address } = await setup(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const nativeRequests: string[] = [];
  page.on('request', request => { if (/\/(attach|create)$/.test(new URL(request.url()).pathname)) nativeRequests.push(request.url()); });
  await page.locator('.lab-session-dock-add').click();
  const view = page.locator('.lab-bindable-session-window[data-view-id]');
  await expect(view).toHaveCount(1); await expect(view.getByText('Choose a session from the sidebar')).toBeVisible();
  const id = await view.getAttribute('data-view-id');
  expect(nativeRequests).toEqual([]);
  await expect(page.locator('.lab-session-open-target')).toContainText('Empty session view');
  await choose(page, 'Window alpha');
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await view.getByTestId('prompt-input').fill('Alpha draft belongs to alpha');
  await view.getByRole('button', { name: 'Session view options', exact: true }).click();
  await view.getByRole('radio', { name: 'Simple conversation', exact: true }).check();
  await view.getByRole('button', { name: 'Session view options', exact: true }).click();
  const dock = page.locator('.lab-session-dock-pane');
  await dock.getByRole('separator').focus(); await page.keyboard.press('ArrowRight');
  const width = await dock.evaluate(node => node.style.width);
  await clickSessionAction(view, 'Change session');
  await choose(page, 'Window beta');
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expect(view.getByTestId('prompt-input')).toBeEmpty();
  await expect(view).toHaveAttribute('data-view-id', id!); await expect(dock).toHaveCSS('width', width);
  await expect(view.getByRole('button', { name: 'Session view options', exact: true })).toHaveAttribute('title', 'View: Simple conversation');
  await expect(page).toHaveURL(address);
  await clickSessionAction(view, 'Change session'); await choose(page, 'Window alpha');
  await expect(view.getByTestId('prompt-input')).toContainText('Alpha draft belongs to alpha');
  await page.locator('.lab-session-dock-add').click();
  await expect(page.locator('.lab-bindable-session-window[data-view-id]')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.lab-bindable-session-window[data-view-id]')).toHaveCount(2);
  const alpha = page.locator(`.lab-bindable-session-window[data-view-id="${id}"]`);
  await expect(alpha.getByTestId('prompt-input')).toContainText('Alpha draft belongs to alpha');
  await expect(page.locator('.lab-bindable-session-window[data-view-id][data-active]')).toContainText('Select session');
  await page.screenshot({ path: info.outputPath('empty-and-bound-views.png') });
  // A narrow viewport shows the selected pane without destroying the wider layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lab-session-dock-add')).toHaveCount(0);
  await expect(page.locator('.lab-bindable-session-window[data-view-id]:visible')).toHaveCount(1);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await expect(page.locator('.lab-bindable-session-window[data-view-id]:visible')).toHaveCount(2);
  await expect(page).toHaveURL(address); expect(errors).toEqual([]);
});

test('rebind and close invalidate old attachments; a failed binding remains retryable', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Creation belongs to the wide workspace.');
  const { targets, address } = await setup(page);
  let release: (() => void) | undefined, arrived = false;
  await page.route('**/v1/remote/attach', async route => {
    if (route.request().postDataJSON().nativeSessionId === targets[0]!.nativeSessionId) {
      arrived = true; await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: targets[0] }).catch(() => {});
    } else await route.continue();
  });
  await page.locator('.lab-session-dock-add').click();
  const view = page.locator('.lab-bindable-session-window[data-view-id]');
  await choose(page, 'Window alpha'); await expect.poll(() => arrived).toBe(true);
  await expect(view.getByRole('heading', { name: /^Opening session/ })).toBeVisible();
  await clickSessionAction(view, 'Change session'); await choose(page, 'Window beta');
  await expect(view.getByTestId('prompt-input')).toBeEnabled(); release!();
  await expect(view.getByRole('region', { name: 'Window beta', exact: true })).toBeVisible();
  arrived = false;
  await clickSessionAction(view, 'Change session'); await choose(page, 'Window alpha');
  await expect.poll(() => arrived).toBe(true);
  await view.getByRole('button', { name: 'Close Window alpha', exact: true }).click(); release!();
  await expect(view).toHaveCount(0);
  await page.unroute('**/v1/remote/attach');
  let fail = true;
  await page.route('**/v1/remote/attach', route => fail ? route.fulfill({ status: 503, json: { error: 'Host temporarily unavailable' } }) : route.continue());
  await page.locator('.lab-session-dock-add').click(); await choose(page, 'Window alpha');
  await expect(view.getByRole('alert')).toContainText('Host temporarily unavailable');
  await showSessionAction(view, 'Change session');
  fail = false; await view.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(view.locator('.agent-message-user')).toContainText('Recorded history 1');
  await expect(view.getByRole('heading', { name: /^Opening session/ })).toHaveCount(0);
  await view.getByTestId('prompt-input').fill('Ready after retry');
  await expect(view.getByTestId('prompt-submit')).toBeEnabled();
  await expect(page).toHaveURL(address);
});

test('favorites target the focused view, while Track and explicit main navigation preserve docks', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Window targeting belongs to the wide workspace.');
  await page.setViewportSize({ width: 1680, height: 1000 });
  const star = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1, available: true, online: true, hostName: 'Work Mac' };
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [star] } }));
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 1, folders: [], stars: [{ ...star, favoriteId: 'favorite-1', folderId: null, order: 0 }] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: 'background-session', nativeSessionId: 'background-session' } }));
  await page.addInitScript(() => {
    localStorage.setItem('agent-remote:track-view', 'true');
    localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify([{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1 }]));
  });
  await page.goto('/e2e/fixtures/session-stars.html?switching=1');
  await page.locator('.lab-session-dock-add').click();
  const view = page.locator('.lab-bindable-session-window[data-view-id]');
  await expect(view.getByText('Choose a session from the sidebar')).toBeVisible();
  const address = page.url();
  await page.locator('.lab-sidebar-tabs').getByRole('button', { name: 'Favorites', exact: true }).click();
  await page.locator('.lab-favorites-section .lab-session-row').filter({ hasText: 'Build checks' }).click();
  await expect(view.locator('.agent-message-assistant')).toContainText('Conversation for background-session');
  await expect(page).toHaveURL(address);
  const id = await view.getAttribute('data-view-id');
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await page.locator('.lab-tracking-floating .lab-session-row').filter({ hasText: 'Build checks' }).click();
  await expect(page).toHaveURL(/session=background-session/);
  await expect(view).toHaveAttribute('data-view-id', id!);
  await expect(view.locator('.agent-message-assistant')).toContainText('Conversation for background-session');
  await showSessions(page);
  await expect(page.locator('.lab-session-open-target')).toContainText('Main session');
});

test('a restored bound view shows cached content and keeps its draft before attachment recovers', async ({ page, isMobile }) => {
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
  await expect(view.locator('.agent-message-user')).toContainText('Recorded history 1');
  await expect(view.getByTestId('prompt-input')).toContainText('Draft while reconnecting');
  fail = false; await view.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expect(view.getByTestId('prompt-input')).toContainText('Draft while reconnecting');
});

test('two ordinary views of the same session reuse its draft owner and live connection', async ({ page, isMobile }) => {
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
  await expect(view.getByTestId('prompt-input')).toContainText('Shared session draft');
  await view.getByTestId('prompt-input').fill('Changed from the second view');
  await expect(main.getByTestId('prompt-input')).toContainText('Changed from the second view');
  expect(attachments).toEqual([]);
  await view.getByRole('button', { name: 'Close New session', exact: true }).click();
  await expect(main.getByTestId('prompt-input')).toBeEnabled();
});
