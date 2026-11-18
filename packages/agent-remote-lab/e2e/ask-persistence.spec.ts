import { expect, test, type Page } from '@playwright/test';
import { selectConnectedHost, addSessionView } from './all-sessions';
import { showNewSession } from './session-navigation';
import { sessionLinkFixture } from './session-link-fixture';

async function remoteSource(page: Page, fixture: Awaited<ReturnType<typeof sessionLinkFixture>>) {
  await page.goto(fixture.url + '/auth/login');
  await page.getByRole('link', { name: 'Sign in as alice', exact: true }).click();
  await selectConnectedHost(page, fixture.hostId);
  await showNewSession(page);
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByTestId('session-create').click();
  const identity = await (await created).json() as { nativeSessionId: string };
  const primary = page.locator('.lab-primary-conversation .lab-session-view');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  const nativeSessionId = identity.nativeSessionId;
  await primary.getByTestId('prompt-input').fill('/ask');
  await expect(primary.getByTestId('prompt-submit')).toBeEnabled();
  await primary.getByTestId('prompt-input').press('Enter');
  const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await expect(trigger).toBeEnabled();
  return { nativeSessionId, trigger, ask: page.getByRole('dialog', { name: 'Ask', exact: true }) };
}

test('a hosted global Ask keeps Window, Team, Track and View controls available', async ({ page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await sessionLinkFixture();
  try {
    const { trigger, ask } = await remoteSource(page, fixture);
    const view = page.getByRole('button', { name: 'View options', exact: true });
    await view.click();
    const options = page.getByRole('region', { name: 'View options', exact: true });
    await options.getByRole('checkbox', { name: 'Track view', exact: true }).check();
    // TPM view starts hidden for fine pointers.
    await options.getByRole('checkbox', { name: 'TPM view', exact: true }).check();
    // While the desktop sidebar is visible, these controls are its sections and Shortcuts; hidden, they float beside Ask.
    const sidebar = options.getByRole('checkbox', { name: 'Sidebar', exact: true });
    if (!isMobile && await sidebar.isChecked()) await sidebar.uncheck();
    await options.press('Escape');
    await trigger.click();
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    await ask.getByTestId('prompt-input').fill('Keep this hosted Ask draft');
    for (const name of ['Windows', 'Teams', 'Tracked sessions', 'TPM works'] as const) {
      await page.getByRole('button', { name, exact: true }).click();
      const menu = page.getByRole('region', { name, exact: true });
      await expect(menu).toBeVisible();
      await menu.getByRole('button', { name: `Close ${name}`, exact: true }).click();
      await expect(ask).toBeVisible();
      await expect(ask.getByTestId('prompt-input')).toHaveText('Keep this hosted Ask draft');
    }
    await view.click();
    await expect(options.getByRole('checkbox', { name: 'Ask view', exact: true })).toBeChecked();
    await options.press('Escape');
    await expect(ask.getByTestId('prompt-input')).toHaveText('Keep this hosted Ask draft');
  } finally { await fixture.close(); }
});

async function holdRelations(page: Page) {
  let release!: () => void;
  let pending = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/session-relations', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    pending++;
    await gate;
    await route.continue();
  });
  return { release, pending: () => pending };
}

test('Ask appears before slow relations complete and opens the newly discovered shared conversation', async ({ page }) => {
  const fixture = await sessionLinkFixture();
  let release = () => {};
  try {
    const { nativeSessionId, trigger, ask } = await remoteSource(page, fixture);
    const creations: unknown[] = [];
    const attachments: { nativeSessionId: string }[] = [];
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/create')) creations.push(request.postDataJSON());
      if (path.endsWith('/attach')) attachments.push(request.postDataJSON());
    });
    const held = await holdRelations(page);
    release = held.release;
    await trigger.click();
    await expect.poll(held.pending).toBeGreaterThan(0);
    await expect(ask).toBeVisible({ timeout: 1000 });
    await ask.getByRole('textbox', { name: 'Ask draft', exact: true }).fill('Draft while related sessions load');
    expect(creations).toHaveLength(0);
    expect(attachments).toHaveLength(0);

    const status = await (await page.request.get(fixture.url + '/auth/status')).json() as { basePath: string };
    const response = await page.request.post(new URL(`v1/remote/hosts/${fixture.hostId}/create`, fixture.url + status.basePath).href, {
      headers: { origin: fixture.url },
      data: { providerId: 'recorded', operationId: crypto.randomUUID(), conversationKind: 'ask', sourceNativeSessionId: nativeSessionId },
    });
    expect(response.ok()).toBe(true);
    const shared = await response.json() as { nativeSessionId: string };
    release();
    await expect(ask.getByTestId('prompt-input')).toHaveText('Draft while related sessions load');
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    expect(attachments).toEqual([{ providerId: 'recorded', nativeSessionId: shared.nativeSessionId }]);
    expect(creations).toHaveLength(0);
  } finally { release(); await fixture.close(); }
});

test('Ask opens for a session shown in a Window dock', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Docks are a desktop Window presentation.');
  const fixture = await sessionLinkFixture({ automaticSignIn: true, listCreatedSessions: true });
  try {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await selectConnectedHost(page, fixture.hostId);
    await showNewSession(page); await page.getByTestId('session-create').click();
    const primary = page.locator('.lab-primary-group[data-selected="true"]').getByTestId('prompt-input');
    await expect(primary).toBeEnabled();
    await primary.fill('/ask');
    await primary.press('Enter');
    const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
    await expect(trigger).toBeEnabled();
    await addSessionView(page);
    const dock = page.locator('[data-dock-id]').first();
    await dock.click();
    await showNewSession(page);
    const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
    await page.getByTestId('session-create').click();
    const docked = await (await created).json() as { nativeSessionId: string };
    await expect(dock.getByTestId('prompt-input')).toBeEnabled();
    // The dock's view connection holds its own replica of the session.
    await expect(trigger).toBeEnabled();
    const askCreation = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/create'));
    await trigger.click();
    expect((await askCreation).postDataJSON().sourceNativeSessionId).toBe(docked.nativeSessionId);
    await expect(page.getByRole('dialog', { name: 'Ask', exact: true }).getByTestId('prompt-input')).toBeEnabled();
  } finally { await fixture.close(); }
});
