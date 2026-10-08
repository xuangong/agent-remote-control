import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';
import { sessionLinkFixture } from './session-link-fixture';

async function openAsk(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation > .lab-session-view').getByTestId('prompt-input');
  await expect(primary).toBeEnabled();
  await primary.fill('/ask');
  await primary.press('Enter');
  const creations: unknown[] = [];
  const attachments: { nativeSessionId: string }[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/create')) creations.push(request.postDataJSON());
    if (path.endsWith('/attach')) attachments.push(request.postDataJSON());
  });
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const identity = await (await created).json() as { nativeSessionId: string };
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByTestId('prompt-input').fill('Keep the recorded Ask answer across reload');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  await ask.getByTestId('prompt-input').fill('Keep the unsent Ask draft');
  return { ask, identity, creations, attachments };
}

test('reload restores an expanded Ask with the same native conversation and draft', async ({ page }) => {
  const { ask, identity, creations, attachments } = await openAsk(page);
  await page.reload();
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  expect(attachments.filter(item => item.nativeSessionId === identity.nativeSessionId)).toHaveLength(1);
  expect(creations).toHaveLength(1);
});

test('an unavailable Ask restoration preserves its draft and retries the existing native identity', async ({ page }) => {
  const { ask, identity, creations, attachments } = await openAsk(page);
  let unavailable = true;
  await page.route('**/v1/remote/attach', async route => {
    if (unavailable && route.request().postDataJSON().nativeSessionId === identity.nativeSessionId) {
      await route.fulfill({ status: 503, json: { error: 'Recorded reconnect unavailable' } });
    } else await route.continue();
  });
  await page.reload();
  await expect(ask.getByRole('alert')).toContainText('Recorded reconnect unavailable');
  await expect(ask.getByRole('textbox', { name: 'Ask draft', exact: true })).toHaveValue('Keep the unsent Ask draft');
  expect(creations).toHaveLength(1);
  expect(attachments.filter(item => item.nativeSessionId === identity.nativeSessionId)).toHaveLength(1);
  unavailable = false;
  await ask.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(ask.getByRole('alert')).toHaveCount(0);
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  expect(attachments.filter(item => item.nativeSessionId === identity.nativeSessionId)).toHaveLength(2);
  expect(creations).toHaveLength(1);
});

test('reload keeps a minimized Ask closed and reopens its saved conversation and draft', async ({ page }) => {
  const { ask, identity, creations, attachments } = await openAsk(page);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.reload();
  const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await expect(trigger).toBeEnabled();
  await expect(ask).toHaveCount(0);
  await trigger.click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  expect(attachments.some(item => item.nativeSessionId === identity.nativeSessionId)).toBe(true);
  expect(creations).toHaveLength(1);
});

async function remoteSource(page: Page, fixture: Awaited<ReturnType<typeof sessionLinkFixture>>) {
  await page.goto(fixture.url + '/auth/login');
  await page.getByRole('link', { name: 'Sign in as alice', exact: true }).click();
  await page.getByLabel('Connected Host').selectOption(fixture.hostId);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation > .lab-session-view');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  const nativeSessionId = new URL(page.url()).searchParams.get('session')!;
  await primary.getByTestId('prompt-input').fill('/ask');
  await primary.getByTestId('prompt-input').press('Enter');
  const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await expect(trigger).toBeEnabled();
  return { nativeSessionId, trigger, ask: page.getByRole('dialog', { name: 'Ask', exact: true }) };
}

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
    await expect(ask.getByTestId('prompt-input')).toHaveValue('Draft while related sessions load');
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    expect(attachments).toEqual([{ providerId: 'recorded', nativeSessionId: shared.nativeSessionId }]);
    expect(creations).toHaveLength(0);
  } finally { release(); await fixture.close(); }
});

test('minimizing Ask while relations are pending does not later reopen or create a conversation', async ({ page }) => {
  const fixture = await sessionLinkFixture();
  let release = () => {};
  try {
    const { trigger, ask } = await remoteSource(page, fixture);
    const writes: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/(create|attach)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    const held = await holdRelations(page);
    release = held.release;
    await trigger.click();
    await expect.poll(held.pending).toBeGreaterThan(0);
    await expect(ask).toBeVisible({ timeout: 1000 });
    await ask.getByRole('textbox', { name: 'Ask draft', exact: true }).fill('Keep this minimized draft');
    // Keep the global Track control clear of the source-bound Ask close button.
    const tracking = page.getByRole('button', { name: 'Tracked sessions', exact: true });
    for (let move = 0; move < 4; move++) await tracking.press('Shift+ArrowLeft');
    await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click({ timeout: 1000 });
    await expect(ask).toHaveCount(0);
    const completed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/v1/session-relations'));
    release();
    await (await completed).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(ask).toHaveCount(0);
    await expect(trigger).toBeVisible();
    expect(writes).toEqual([]);

    await trigger.click();
    await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep this minimized draft');
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    expect(writes.filter(url => new URL(url).pathname.endsWith('/create'))).toHaveLength(1);
  } finally { release(); await fixture.close(); }
});
