import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWindowView, type WindowGroup, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { showNewSession } from './session-navigation';
import { sessionLinkFixture } from './session-link-fixture';
import { joinedFixture } from './session-succession-joined-fixture';
import { activateComposerAction } from './composer-actions';

const modeRegion = (page: Page, mode: 'window' | 'bot') => page.locator(`[data-workbench-mode="${mode}"]`);
const composer = (page: Page, mode: 'window' | 'bot') => modeRegion(page, mode).getByTestId('prompt-input').locator('visible=true');
async function expectDraft(input: Locator, text: string) {
  if (await input.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) await expect(input).toHaveValue(text);
  else await expect(input).toHaveText(text);
}
async function showWindowConversation(page: Page) {
  const window = modeRegion(page, 'window'); await expect(window).toBeVisible();
  const close = window.getByRole('button', { name: 'Close Context', exact: true });
  if (await close.isVisible()) await close.click();
  await expect(composer(page, 'window').first()).toBeEnabled();
}

test('clears one successful held send while staying in Window mode', async ({ page }) => {
  const { captured } = await openRecordedBot(page);
  const text = 'One Window-only held send';
  let holding = true, release!: () => void, releaseEcho!: () => void, held!: () => void;
  const waiting = new Promise<void>(resolve => { held = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const echoGate = new Promise<void>(resolve => { releaseEcho = resolve; });
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(async message => {
      const envelope = JSON.parse(String(message)), frame = envelope.type === 'message' ? envelope.message : envelope;
      if (holding && frame.type === 'command_acknowledged' && frame.payload.command === 'send_message') { held(); await gate; }
      else if (String(message).includes(text)) await echoGate;
      route.send(message);
    });
  });
  await page.reload(); await expect(composer(page, 'window')).toBeEnabled();
  const sendsBefore = captured.sends.length;
  try {
    await composer(page, 'window').fill(text);
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled();
    await composer(page, 'window').press('Enter'); await waiting;
    await expectDraft(composer(page, 'window'), text);
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeDisabled();
    expect(captured.sends).toHaveLength(sendsBefore + 1);
    holding = false; release();
    await expect(modeRegion(page, 'window').locator('.agent-outgoing-message')).toContainText('Sent — waiting for conversation…');
    await expectDraft(composer(page, 'window'), '');
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeDisabled();
    const draftAfterAck = await composer(page, 'window').evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '');
    const directory = resolve('../../.tmp/local/bot-mode'); await mkdir(directory, { recursive: true });
    await expect(modeRegion(page, 'bot')).toBeHidden();
    await screenshot(page, 'window-only-ack-control'); releaseEcho();
    await composer(page, 'window').fill('Later Window-only draft');
    await expectDraft(composer(page, 'window'), 'Later Window-only draft');
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled();
    expect(captured.sends).toHaveLength(sendsBefore + 1); expect(captured.creates).toHaveLength(1);
    await writeFile(resolve(directory, `${test.info().project.name}-window-only-ack-control.json`), JSON.stringify({ mode: 'window', sends: captured.sends.length - sendsBefore, pending: false, nativeEchoHeldAtAck: true, draftAfterAck, laterDraftEnabled: true }, null, 2));
  } finally { holding = false; release(); releaseEcho(); }
});

test('retains an in-flight send and a later draft through mode switches without replay', async ({ page }) => {
  const { captured } = await openRecordedBot(page);
  let holding = true, release!: () => void, releaseEcho!: () => void, held!: () => void;
  const waiting = new Promise<void>(resolve => { held = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const echoGate = new Promise<void>(resolve => { releaseEcho = resolve; });
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(async message => {
      const envelope = JSON.parse(String(message)), frame = envelope.type === 'message' ? envelope.message : envelope;
      if (holding && frame.type === 'command_acknowledged' && frame.payload.command === 'send_message') { held(); await gate; }
      else if (String(message).includes('One original in-flight send')) await echoGate;
      route.send(message);
    });
  });
  await page.reload(); await expect(composer(page, 'window')).toBeEnabled();
  const sendsBefore = captured.sends.length;
  try {
    await composer(page, 'window').fill('One original in-flight send');
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled();
    await composer(page, 'window').press('Enter'); await waiting;
    await mode(page, 'bot'); await modeRegion(page, 'bot').getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    await expectDraft(composer(page, 'bot'), 'One original in-flight send');
    await expect(modeRegion(page, 'bot').getByTestId('prompt-submit')).toBeDisabled();
    await screenshot(page, 'in-flight-bot');
    await mode(page, 'window'); expect(captured.sends).toHaveLength(sendsBefore + 1);
    holding = false; release();
    await expect(modeRegion(page, 'window').locator('.agent-outgoing-message')).toContainText('Sent — waiting for conversation…');
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled();
    await expectDraft(composer(page, 'window'), 'One original in-flight send');
    await screenshot(page, 'acknowledged-retained-draft'); releaseEcho();
    await composer(page, 'window').fill('Draft after one send'); await mode(page, 'bot');
    await expectDraft(composer(page, 'bot'), 'Draft after one send');
    expect(captured.sends).toHaveLength(sendsBefore + 1); expect(captured.creates).toHaveLength(1);
  } finally { holding = false; release(); releaseEcho(); }
});

function fixtureClient(context: BrowserContext, scope: string, origin: string) {
  return new WindowWorkspaceClient(scope, async (input, init) => {
    const response = await context.request.fetch(String(input), { method: init?.method, headers: { origin, 'content-type': 'application/json' }, data: init?.body as string | undefined, timeout: 10000 });
    return new Response(await response.text(), { status: response.status(), headers: response.headers() });
  });
}
async function mutate(client: WindowWorkspaceClient, id: string, operation: WindowGroupOperation) {
  const before = await client.inspect(id);
  const after = await client.mutate(id, { operationId: randomUUID(), issuedAt: Date.now(), baseRevision: before.window.revision, operation });
  expect(after.result.status, after.result.message).toBe('committed'); return after;
}

test('keeps Window A while selecting another group, handles section-only routes and a second-client removal', async ({ page, context }) => {
  const fixture = await sessionLinkFixture({ automaticSignIn: true, listCreatedSessions: true, sessionStates: true });
  const captured = operations(page);
  try {
    await page.goto(fixture.url); await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId); await showNewSession(page); await page.getByTestId('session-create').click();
    await expect(composer(page, 'window')).toBeEnabled();
    const access = await (await context.request.get(fixture.url + '/auth/status')).json();
    const client = fixtureClient(context, fixture.url + access.basePath, fixture.url);
    const aId = new URL(page.url()).searchParams.get('window')!;
    const a = await client.inspect(aId), binding = a.window.views.find(view => view.binding)!.binding!;
    const bId = randomUUID();
    await client.create({ schemaVersion: 3, id: bId, revision: 0, title: 'Window B', views: [createWindowView('B1', { ...binding, title: 'Bot B' }, 'primary')], selectedViewId: 'B1', selectedPrimaryViewId: 'B1' });
    await page.goto(`${fixture.url}/?window=${bId}`); await showWindowConversation(page);
    let menu = await windows(page); await menu.locator('details.lab-window-options > summary').click();
    await menu.getByRole('button', { name: 'Show as section', exact: true }).click();
    await expect.poll(async () => !!(await client.inspect(bId)).bots).toBe(true);
    await menu.getByRole('button', { name: 'Close Windows', exact: true }).click();
    await page.goto(`${fixture.url}/?window=${aId}`); await showWindowConversation(page);
    const before = await client.inspect(aId); await mode(page, 'bot');
    const bot = modeRegion(page, 'bot'); await bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'Bot B', exact: true }).click();
    await expect(bot.getByRole('heading', { name: 'Bot B', exact: true })).toBeVisible();
    expect((await client.inspect(aId)).window).toEqual(before.window);
    await composer(page, 'bot').fill('B draft independent of A'); await page.reload();
    await expectDraft(composer(page, 'bot'), 'B draft independent of A');
    await mode(page, 'window'); expect(new URL(page.url()).searchParams.get('window')).toBe(aId);
    await page.reload(); await expect(modeRegion(page, 'window')).toBeVisible();
    await mode(page, 'bot'); await expectDraft(composer(page, 'bot'), 'B draft independent of A');
    await mutate(client, bId, { type: 'view.close', viewId: 'B1' });
    await expect(bot.getByRole('alert')).toContainText('unavailable');
    await expect(bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'Bot B', exact: true })).toHaveCount(0);
    await expect(bot.getByTestId('prompt-input').locator('visible=true')).toHaveCount(0);
    await screenshot(page, 'removed-selected-bot');
    await expect(bot.locator('.lab-bot-roster')).toBeVisible();
    await expect(bot.getByRole('button', { name: 'New section', exact: true })).toBeVisible();
    await bot.getByRole('button', { name: 'New section', exact: true }).click();
    await bot.getByRole('textbox', { name: 'Section title', exact: true }).fill('Empty section');
    await bot.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(url => !!url.searchParams.get('section') && url.searchParams.get('section') !== bId);
    await expect(bot.getByRole('region', { name: 'Empty section', exact: true }).getByText('No bots in this section yet. Organize sessions in a Window, then choose Show as section.', { exact: true })).toBeVisible();
    const sectionId = new URL(page.url()).searchParams.get('section')!;
    expect((await client.inspect(sectionId)).presentation).toEqual({ window: false });
    const createsBefore = captured.creates.length, attachesBefore = captured.attaches.length;
    await page.goto(`${fixture.url}/?window=${sectionId}&session=stale&host=${fixture.hostId}&provider=recorded`);
    await expect(modeRegion(page, 'bot')).toBeVisible();
    await expect(modeRegion(page, 'window')).toBeHidden();
    await expect(page).toHaveURL(url => url.searchParams.get('mode') === 'bot' && url.searchParams.get('section') === sectionId && !url.searchParams.has('window'));
    await expect(bot.getByRole('region', { name: 'Empty section', exact: true }).getByText('No bots in this section yet. Organize sessions in a Window, then choose Show as section.', { exact: true })).toBeVisible();
    expect(captured.creates).toHaveLength(createsBefore); expect(captured.attaches.slice(attachesBefore)).not.toContain('stale');
    expect(captured.sends).toHaveLength(0); await screenshot(page, 'empty-section-route');
  } finally { await page.close(); await fixture.close(); }
});
for (const change of ['hidden', 'ineligible'] as const) {
  test(`shows the compact roster without Back when the selected Bot becomes ${change}`, async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await sessionLinkFixture({ automaticSignIn: true });
    const captured = operations(page);
    try {
      await page.goto(fixture.url); await page.getByRole('link', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('Connected Host').selectOption(fixture.hostId); await showNewSession(page); await page.getByTestId('session-create').click();
      await expect(composer(page, 'window')).toBeEnabled();
      const access = await (await context.request.get(fixture.url + '/auth/status')).json();
      const client = fixtureClient(context, fixture.url + access.basePath, fixture.url), id = new URL(page.url()).searchParams.get('window')!;
      const group = await client.inspect(id), view = group.window.views.find(view => view.binding)!;
      const menu = await windows(page); await menu.locator('details.lab-window-options > summary').click();
      await menu.getByRole('button', { name: 'Show as section', exact: true }).click();
      await expect.poll(async () => !!(await client.inspect(id)).bots).toBe(true);
      await menu.getByRole('button', { name: 'Close Windows', exact: true }).click(); await mode(page, 'bot');
      const bot = modeRegion(page, 'bot'); await bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
      await expectDraft(composer(page, 'bot'), ''); const beforeUrl = page.url();
      if (change === 'hidden') await mutate(client, id, { type: 'bot.update', viewId: view.id, details: { hidden: true } });
      else {
        const window = (await client.inspect(id)).window;
        await mutate(client, id, { type: 'layout.apply', layout: { title: window.title, selectedViewId: window.selectedViewId,
          selectedPrimaryViewId: window.selectedPrimaryViewId, views: window.views.map(item => item.id === view.id ? { ...item, bindingPolicy: 'managed' } : item) } });
      }
      await expect(bot.locator('.lab-bot-roster')).toBeVisible();
      await expect(bot.locator('.lab-bot-roster').getByRole('alert')).toContainText('unavailable');
      await expect(bot.locator('.lab-bot-roster').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      await expect(bot.getByRole('button', { name: 'New section', exact: true })).toBeVisible();
      await expect(bot.getByTestId('prompt-input').locator('visible=true')).toHaveCount(0);
      expect(page.url()).toBe(beforeUrl); expect(captured.sends).toHaveLength(0); expect(captured.creates).toHaveLength(1);
      await noOverflow(page); await screenshot(page, `compact-${change}-roster`);
    } finally { await page.close(); await fixture.close(); }
  });
}
async function mode(page: Page, value: 'window' | 'bot') {
  const region = modeRegion(page, value === 'bot' ? 'window' : 'bot');
  let button: Locator;
  if (value === 'bot') {
    const trigger = region.getByRole('button', { name: 'View options', exact: true });
    await expect(trigger).toBeVisible();
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    button = region.getByRole('region', { name: 'View options', exact: true }).getByRole('button', { name: 'Bot mode', exact: true });
  } else button = region.getByRole('button', { name: 'Window mode', exact: true }).locator('visible=true');
  await button.click(); await expect(modeRegion(page, value)).toBeVisible();
  await expect(region).toBeHidden(); await expect(region).toHaveAttribute('inert', '');
}
async function windows(page: Page) {
  const region = modeRegion(page, 'window');
  const trigger = region.getByRole('button', { name: 'Windows', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  return region.getByRole('region', { name: 'Windows', exact: true });
}
function operations(page: Page) {
  const creates: unknown[] = [], attaches: string[] = [], sends: unknown[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/create')) creates.push(request.postDataJSON());
    if (path.endsWith('/attach')) attaches.push(request.postDataJSON().nativeSessionId);
  });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const envelope = JSON.parse(String(payload));
    const message = envelope.type === 'message' ? envelope.message : envelope;
    if (message.type === 'send_message') sends.push(message);
  }));
  return { creates, attaches, sends };
}
async function screenshot(page: Page, name: string) {
  const directory = resolve('../../.tmp/local/bot-mode'); await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${test.info().project.name}-${name}.png`) });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await modeRegion(page, 'bot').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function openRecordedBot(page: Page) {
  const captured = operations(page);
  await page.goto('/'); await showNewSession(page);
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByTestId('session-create').click();
  const { agentId } = await (await created).json();
  await expect(composer(page, 'window')).toBeEnabled();
  const menu = await windows(page);
  if (!await menu.locator('[data-window-id][aria-current="true"]').count()) {
    await menu.getByRole('button', { name: 'New Window', exact: true }).click();
  }
  const windowId = (await menu.locator('[data-window-id][aria-current="true"]').getAttribute('data-window-id'))!;
  const options = menu.locator('details.lab-window-options');
  if (!await options.evaluate(element => element.hasAttribute('open'))) await options.locator('summary').click();
  await menu.getByRole('button', { name: 'Show as section', exact: true }).click();
  await menu.getByRole('button', { name: 'Close Windows', exact: true }).click();
  return { windowId, captured, agentId: agentId as string };
}
async function savedLocalGroup(page: Page, id: string): Promise<WindowGroup> {
  return page.evaluate(id => {
    const key = Object.keys(localStorage).find(key => key.includes(':shared-window:') && key.endsWith(`:${id}`));
    if (!key) throw new Error('The UI-created Window must be saved.');
    return JSON.parse(localStorage.getItem(key)!);
  }, id);
}

test('selects the Window pane through timeline clicks and composer focus while Bot interactions keep Window place', async ({ page, context }) => {
  await page.setViewportSize({ width: 1900, height: 1000 });
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  try {
    await page.goto(fixture.url); await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId); await showNewSession(page); await page.getByTestId('session-create').click();
    await expect(composer(page, 'window')).toBeEnabled();
    const access = await (await context.request.get(fixture.url + '/auth/status')).json();
    const client = fixtureClient(context, fixture.url + access.basePath, fixture.url), id = new URL(page.url()).searchParams.get('window')!;
    const before = await client.inspect(id), first = before.window.views.find(view => view.binding)!;
    const menu = await windows(page); await menu.locator('details.lab-window-options > summary').click();
    await menu.getByRole('button', { name: 'Show as section', exact: true }).click();
    await expect.poll(async () => !!(await client.inspect(id)).bots).toBe(true);
    const response = await context.request.post(`${fixture.url}${access.basePath}v1/remote/hosts/${fixture.hostId}/create`, {
      headers: { origin: fixture.url }, data: { providerId: first.binding!.providerId, operationId: randomUUID() }, timeout: 10000,
    });
    expect(response.ok()).toBe(true); const second = await response.json();
    await mutate(client, id, { type: 'batch', operations: [
      { type: 'view.create', view: createWindowView('B2', { ...first.binding!, nativeSessionId: second.nativeSessionId, title: 'Second pane' }, 'primary') },
      { type: 'view.select', viewId: 'B2' },
    ] });
    await page.reload();
    const pane = modeRegion(page, 'window').locator(`[data-view-id=${JSON.stringify(first.id)}]`);
    await expect(pane.getByTestId('prompt-input')).toBeVisible();
    await pane.locator('.agent-message-assistant').last().click();
    await expect.poll(async () => (await client.inspect(id)).window.selectedViewId).toBe(first.id);
    await mutate(client, id, { type: 'view.select', viewId: 'B2' }); await page.reload();
    await pane.getByTestId('prompt-input').focus();
    await expect.poll(async () => (await client.inspect(id)).window.selectedViewId).toBe(first.id);
    await mutate(client, id, { type: 'view.select', viewId: 'B2' }); await page.reload(); await mode(page, 'bot');
    const bot = modeRegion(page, 'bot'); await bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    await composer(page, 'bot').fill('Bot interaction keeps the second Window pane');
    await bot.locator('.agent-message-assistant').last().click();
    expect((await client.inspect(id)).window.selectedViewId).toBe('B2');
  } finally { await page.close(); await fixture.close(); }
});

test('keeps an offline queue hidden, dispatches once on return and preserves the later draft', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { captured } = await openRecordedBot(page);
  await mode(page, 'bot');
  const bot = modeRegion(page, 'bot'); await bot.getByRole('button', { name: 'New section', exact: true }).click();
  await bot.getByRole('textbox', { name: 'Section title', exact: true }).fill('Queue home');
  await bot.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(bot.getByRole('button', { name: 'Queue home', exact: true })).toBeVisible(); await mode(page, 'window');
  const sockets: Array<() => void> = [];
  let restoring = false, reconnected = false, blockingSockets = false;
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const envelope = JSON.parse(String(payload)), frame = envelope.type === 'message' ? envelope.message : envelope;
    if (restoring && frame.type === 'negotiated') reconnected = true;
  }));
  await page.routeWebSocket(/session-channel/, route => {
    if (blockingSockets) { route.close(); return; }
    route.connectToServer(); sockets.push(() => route.close());
  });
  await page.reload(); await composer(page, 'window').fill('One queued offline send');
  await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled();
  blockingSockets = true; await context.setOffline(true); for (const close of sockets.splice(0)) close();
  await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled();
  await modeRegion(page, 'window').getByTestId('prompt-submit').click();
  await expect(modeRegion(page, 'window').getByTestId('pending-send')).toContainText('One queued offline send');
  await composer(page, 'window').fill('Later editable draft'); await mode(page, 'bot');
  const nav = modeRegion(page, 'bot').getByRole('navigation', { name: 'Bots', exact: true });
  await nav.getByRole('button', { name: 'New session', exact: true }).click();
  await expectDraft(composer(page, 'bot'), 'Later editable draft');
  await expect(modeRegion(page, 'bot').getByTestId('pending-send')).toContainText('One queued offline send');
  await nav.getByRole('button', { name: 'Queue home', exact: true }).click();
  restoring = true; blockingSockets = false; await context.setOffline(false); await expect.poll(() => reconnected).toBe(true);
  await expect(modeRegion(page, 'bot').getByRole('region', { name: 'Bot conversation', exact: true }).getByRole('heading', { name: 'Queue home', exact: true })).toBeVisible();
  expect(captured.sends).toHaveLength(0);
  await nav.getByRole('button', { name: 'New session', exact: true }).click();
  await expect.poll(() => captured.sends.length).toBe(1);
  await expect(modeRegion(page, 'bot').getByTestId('pending-send')).toHaveCount(0);
  await expectDraft(composer(page, 'bot'), 'Later editable draft'); await screenshot(page, 'offline-queue-return');
  await mode(page, 'window'); await mode(page, 'bot'); expect(captured.sends).toHaveLength(1);
  await expectDraft(composer(page, 'bot'), 'Later editable draft'); expect(captured.creates).toHaveLength(1);
});

test('keeps normal question, approval and error controls visible in fixed Bot content', async ({ page }) => {
  const { agentId } = await openRecordedBot(page); await mode(page, 'bot');
  const bot = modeRegion(page, 'bot'); await bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
  const origin = new URL(page.url()).origin;
  const advance = await page.request.post(`/v1/lab/recorded/${encodeURIComponent(agentId)}/advance`, { headers: { origin } }); expect(advance.ok()).toBe(true);
  await bot.getByLabel('Stable (Recommended)').check(); await bot.getByRole('button', { name: 'Submit response', exact: true }).click();
  await expect(bot.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await screenshot(page, 'plan-approval'); await bot.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(bot.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  await screenshot(page, 'tool-approval'); await bot.getByRole('button', { name: 'Allow once', exact: true }).click();
  await bot.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(bot.getByTestId('timeline').getByText('All recorded interactions resolved.', { exact: true })).toBeVisible();
  const failed = await page.request.post(`/v1/lab/recorded/${encodeURIComponent(agentId)}/fail`, { headers: { origin } }); expect(failed.ok()).toBe(true);
  await expect(bot.getByRole('alert').filter({ hasText: 'Recorded deterministic failure.' })).toBeVisible();
  await noOverflow(page); await screenshot(page, 'ordinary-error');
});

test('reads long Bot labels with independent roster and conversation scrolling', async ({ page, context, browserName, isMobile }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  try {
    await page.goto(fixture.url); await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId); await showNewSession(page); await page.getByTestId('session-create').click();
    await composer(page, 'window').fill('A long conversation paragraph with enough readable content to scroll. '.repeat(40));
    await expect(modeRegion(page, 'window').getByTestId('prompt-submit')).toBeEnabled(); await composer(page, 'window').press('Enter');
    await expect(modeRegion(page, 'window').locator('.agent-message-assistant').last()).toContainText('Recorded reply:');
    const access = await (await context.request.get(fixture.url + '/auth/status')).json();
    const client = fixtureClient(context, fixture.url + access.basePath, fixture.url), id = new URL(page.url()).searchParams.get('window')!;
    const group = await client.inspect(id), original = group.window.views.find(view => view.binding)!, binding = original.binding!;
    const menu = await windows(page); await menu.locator('details.lab-window-options > summary').click();
    await menu.getByRole('button', { name: 'Show as section', exact: true }).click();
    await expect.poll(async () => !!(await client.inspect(id)).bots).toBe(true);
    const otherBindings = [];
    for (let index = 1; index <= 35; index++) {
      const response = await context.request.post(`${fixture.url}${access.basePath}v1/remote/hosts/${fixture.hostId}/create`, {
        headers: { origin: fixture.url }, data: { providerId: binding.providerId, operationId: randomUUID() }, timeout: 10000,
      });
      expect(response.ok()).toBe(true);
      const created = await response.json();
      otherBindings.push({ ...binding, nativeSessionId: created.nativeSessionId as string, title: `Bot ${index}: ${'A descriptive title for a continuing conversation '.repeat(3)}` });
    }
    const title = `Bot 0: ${'A descriptive title for a continuing conversation '.repeat(3)}`.trim();
    await mutate(client, id, { type: 'batch', operations: [
      { type: 'view.bind', viewId: original.id, binding: { ...binding, title } },
      ...otherBindings.map((target, index) => ({ type: 'view.create' as const, view: createWindowView(`long-${index + 1}`, target, 'primary') })),
    ] });
    const label = 'A readable label that wraps naturally across the available roster width. '.repeat(2).slice(0, 120);
    await mutate(client, id, { type: 'bot.update', viewId: original.id, details: { label, picture: { shape: 'hexagon', color: '#35836b' }, pinned: true } });
    await menu.getByRole('button', { name: 'Close Windows', exact: true }).click(); await mode(page, 'bot');
    const bot = modeRegion(page, 'bot'), nav = bot.getByRole('navigation', { name: 'Bots', exact: true });
    const row = nav.locator('[data-bot-place]').filter({ hasText: label }); await expect(row).toHaveCount(1); await row.click();
    await expect(row).toHaveAccessibleName(title);
    await expect(row.getByText(label, { exact: true })).toBeVisible(); await noOverflow(page);
    await screenshot(page, 'long-label-roster');
    const roster = bot.locator('.lab-bot-roster'), timeline = bot.getByTestId('timeline');
    const before = await timeline.evaluate(element => element.scrollTop);
    const keyboardScroll = browserName === 'webkit' && isMobile;
    if (keyboardScroll) {
      await nav.locator('[data-bot-place]').last().focus();
    } else { await roster.hover(); await page.mouse.wheel(0, 500); }
    await expect.poll(() => roster.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    expect(await timeline.evaluate(element => element.scrollTop)).toBe(before);
    const rosterPosition = await roster.evaluate(element => element.scrollTop);
    if (keyboardScroll) { await timeline.focus(); await timeline.press('PageUp'); }
    else { await timeline.hover(); await page.mouse.wheel(0, -500); }
    await expect.poll(() => timeline.evaluate(element => -element.scrollTop)).toBeGreaterThan(100);
    expect(await roster.evaluate(element => element.scrollTop)).toBe(rosterPosition);
    await screenshot(page, 'long-label-independent-scroll');
  } finally { await page.close(); await fixture.close(); }
});

test('keeps Handoff modal and progress reachable across Bot and Window without retargeting', async ({ page, context }) => {
  const fixture = await joinedFixture(); let release = () => {}, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await fixture.seed(context); const client = fixtureClient(context, fixture.scope, fixture.origin);
    const target = (nativeSessionId: string, title: string) => ({ hostId: fixture.hostId, providerId: 'fixture', nativeSessionId, title });
    const aId = randomUUID(), bId = randomUUID();
    await client.create({ schemaVersion: 3, id: aId, revision: 0, title: 'Window A', views: [createWindowView('A1', target('A', 'Window A session'), 'primary')], selectedViewId: 'A1', selectedPrimaryViewId: 'A1' });
    await client.create({ schemaVersion: 3, id: bId, revision: 0, title: 'Window B', views: [createWindowView('B1', target('S', 'Bot source S'), 'primary'), createWindowView('B2', target('T', 'Bot other T'), 'primary')], selectedViewId: 'B2', selectedPrimaryViewId: 'B2' });
    await page.goto(`${fixture.origin}/?window=${bId}`); await showWindowConversation(page);
    await composer(page, 'window').first().fill('Readiness draft');
    const menu = await windows(page); await menu.locator('details.lab-window-options > summary').click();
    await menu.getByRole('button', { name: 'Show as section', exact: true }).click();
    await expect.poll(async () => !!(await client.inspect(bId)).bots).toBe(true);
    await page.goto(`${fixture.origin}/?window=${aId}`); await showWindowConversation(page);
    await composer(page, 'window').fill('Window A draft');
    await mode(page, 'bot');
    const bot = modeRegion(page, 'bot'), nav = bot.getByRole('navigation', { name: 'Bots', exact: true });
    await nav.getByRole('button', { name: 'Bot source S', exact: true }).click();
    await composer(page, 'bot').fill('Retained Bot source draft');
    await expect(bot.getByTestId('prompt-submit')).toBeEnabled();
    const owners = () => page.evaluate(({ scope, groupId }) => {
      const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
      const binding = document.windowBindings.find((entry: { windowId: string; viewId: string }) => entry.windowId === groupId && entry.viewId === 'B1');
      const slot = document.slots.find((slot: { id: string }) => slot.id === binding.slotId);
      return { slotId: slot.id, owners: slot.owners };
    }, { scope: fixture.scope, groupId: bId });
    const beforeOwners = await owners();
    await activateComposerAction(bot, 'Open chat commands', true); await bot.getByRole('option', { name: /^\/handoff/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Hand off conversation', exact: true });
    await expect(dialog).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Hand off', exact: true })).toBeEnabled();
    await screenshot(page, 'handoff-modal');
    fixture.gateCreate(async () => { entered = true; await gate; });
    const before = await client.inspect(aId);
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click(); await expect.poll(() => entered).toBe(true);
    const progress = page.locator('.lab-handoff-notice'); await expect(dialog).toBeHidden();
    await expect(progress).toHaveCount(1); await expect(progress).toBeVisible();
    await progress.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(progress.getByRole('button', { name: 'Cancel Handoff', exact: true })).toBeEnabled();
    await progress.getByRole('button', { name: 'Hide details', exact: true }).click();
    if (await bot.getByRole('button', { name: 'Back to bots', exact: true }).isVisible()) await bot.getByRole('button', { name: 'Back to bots', exact: true }).click();
    await nav.getByRole('button', { name: 'Bot other T', exact: true }).click();
    await expect(progress).toBeVisible(); await mode(page, 'window'); await expect(progress).toBeVisible();
    await progress.getByRole('button', { name: 'Details', exact: true }).click();
    const progressBox = await progress.boundingBox(), viewport = page.viewportSize()!;
    expect(progressBox!.x).toBeGreaterThanOrEqual(0); expect(progressBox!.y).toBeGreaterThanOrEqual(0);
    expect(progressBox!.x + progressBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(progressBox!.y + progressBox!.height).toBeLessThanOrEqual(viewport.height);
    await expect(progress.getByRole('button', { name: 'Cancel Handoff', exact: true })).toBeEnabled();
    await screenshot(page, 'handoff-window-progress');
    expect((await client.inspect(aId)).window).toEqual(before.window); expect(fixture.sessions.get('A')!.sent).toEqual([]);
    await progress.getByRole('button', { name: 'Hide details', exact: true }).click();
    await mode(page, 'bot');
    if (await bot.getByRole('button', { name: 'Back to bots', exact: true }).isVisible()) await bot.getByRole('button', { name: 'Back to bots', exact: true }).click();
    await nav.getByRole('button', { name: 'Bot source S', exact: true }).click(); release();
    await expect.poll(async () => (await client.inspect(bId)).window.views.find(view => view.id === 'B1')?.binding?.nativeSessionId).toBe('B');
    await expect(progress).toBeHidden();
    expect(await owners()).toEqual(beforeOwners);
    await expect(bot.locator('.lab-bot-roster [data-bot-place][aria-current="true"]')).toHaveAttribute('data-bot-place', JSON.stringify([bId, 'B1']));
    await expectDraft(composer(page, 'bot'), 'Retained Bot source draft'); await screenshot(page, 'handoff-complete');
    expect(fixture.creates()).toBe(1); expect(fixture.sessions.get('S')!.sent).toEqual([]); expect(fixture.sessions.get('T')!.sent).toEqual([]);
  } finally { release(); await page.close(); await fixture.close(); }
});

for (const [width, height] of [[1440, 900], [1181, 800], [1180, 800], [390, 844], [320, 568]] as const) {
  test(`keeps one shared editor with keyboard and compact navigation at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const { windowId, captured } = await openRecordedBot(page);
    const before = await savedLocalGroup(page, windowId);
    expect(before.bots).toBeDefined();
    await composer(page, 'window').fill('Keep this draft across modes');
    await composer(page, 'window').evaluate(element => { (element as HTMLElement).dataset.task4Editor = 'retained'; });
    await mode(page, 'bot');
    const bot = modeRegion(page, 'bot'), row = bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name: 'New session', exact: true });
    await expect(row).toBeVisible(); await row.focus(); await row.press('Enter');
    await expect(bot.getByRole('heading', { name: 'New session', exact: true })).toBeFocused();
    await expect(composer(page, 'bot')).toHaveAttribute('data-task4-editor', 'retained');
    await expectDraft(composer(page, 'bot'), 'Keep this draft across modes');
    await expect(page.getByTestId('prompt-input').locator('visible=true')).toHaveCount(1);
    await expect(bot.getByRole('button', { name: 'Session view options', exact: true })).toBeHidden();
    await noOverflow(page);
    if (width <= 1180) {
      await expect(bot.locator('.lab-bot-roster')).toBeHidden();
      await expect(bot.getByRole('button', { name: 'Back to bots', exact: true })).toBeVisible();
      await bot.getByRole('button', { name: 'Back to bots', exact: true }).click();
      await expect(row).toBeFocused(); await expect(bot.getByRole('region', { name: 'Bot conversation', exact: true })).toBeHidden();
      await expect(page.getByTestId('prompt-input').locator('visible=true')).toHaveCount(0);
      await screenshot(page, `roster-${width}`); await row.press('Enter');
    } else {
      await expect(bot.locator('.lab-bot-roster')).toBeVisible();
      const boxes = await Promise.all([bot.locator('.lab-bot-roster').boundingBox(), bot.locator('.lab-bot-conversation').boundingBox()]);
      expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
    }
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-workbench-mode="window"]'))).toBe(false);
    }
    await screenshot(page, `conversation-${width}`);
    await mode(page, 'window'); await expectDraft(composer(page, 'window'), 'Keep this draft across modes');
    const after = await savedLocalGroup(page, windowId);
    expect(after.window.selectedViewId).toBe(before.window.selectedViewId);
    expect(after.window.views.map(view => view.display)).toEqual(before.window.views.map(view => view.display));
    expect(captured.creates).toHaveLength(1); expect(captured.sends).toHaveLength(0);
  });
}
