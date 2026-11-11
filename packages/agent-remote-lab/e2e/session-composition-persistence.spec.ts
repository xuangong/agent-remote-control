import { expect, test, type Locator, type Page } from '@playwright/test';
import { showAllSessions, selectConnectedHost } from './all-sessions';
import { showNewSession, showSessions } from './session-navigation';
import { sessionLinkFixture } from './session-link-fixture';
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

const primaryHistory = 'Keep the primary composition history';
const sideHistory = 'Keep the side composition history';
const askHistory = 'Keep the Ask composition history';
const primaryDraft = 'Unsent primary composition draft';
const sideDraft = 'Unsent side composition draft';
const askDraft = 'Unsent Ask composition draft';

async function send(pane: Locator, text: string) {
  await pane.getByTestId('prompt-input').fill(text);
  await expect(pane.getByTestId('prompt-submit')).toBeEnabled();
  await pane.getByTestId('prompt-input').press('Enter');
}

/** The composer accepts a draft while a new session opens, then hides for a moment as it attaches, which drops focus and typed text; wait until the session is ready. */
async function expectReady(pane: Locator) {
  await expect(pane.getByTestId('prompt-input')).toBeEnabled();
  await expect(pane.getByLabel('Agent activity', { exact: true })).toContainText('Ready');
}

async function expectDraft(input: Locator, text: string) {
  await expect(input).toHaveCount(1);
  if (await input.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) await expect(input).toHaveValue(text);
  else await expect(input).toHaveText(text);
}

async function savedWindow(page: Page): Promise<WorkspaceWindow> {
  return page.evaluate(() => {
    const id = new URL(location.href).searchParams.get('window');
    const key = Object.keys(localStorage).find(key => key.includes(':shared-window:') && key.endsWith(`:${id}`));
    if (!key) throw new Error('The selected Window must have a saved group document.');
    return JSON.parse(localStorage.getItem(key)!).window;
  });
}
const memberships = (window: WorkspaceWindow) => window.views.map(view => ({ id: view.id, attachedTo: view.attachedTo, binding: view.binding }));

async function selectSource(page: Page, pane: Locator, index: number, isMobile: boolean) {
  if (isMobile) await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index });
  else await pane.getByTestId('prompt-input').focus();
  await expect(pane.getByTestId('prompt-input')).toBeEnabled();
}

for (const source of ['primary', 'side'] as const) {
  test(`reload restores Side and ${source}-bound Ask without creating sessions or replaying messages`, async ({ page, isMobile }) => {
    const creates: unknown[] = [];
    const attachments: string[] = [];
    const sends: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/create')) creates.push(request.postDataJSON());
      if (path.endsWith('/attach')) attachments.push(request.postDataJSON().nativeSessionId);
    });
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const envelope = JSON.parse(String(payload));
      const message = envelope.type === 'message' ? envelope.message : envelope;
      if (message?.type === 'send_message') sends.push(JSON.stringify(message));
    }));
    const createdSession = () => page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'))
      .then(response => response.json() as Promise<{ nativeSessionId: string }>);

    await page.goto('/');
    await showNewSession(page);
    const primaryCreated = createdSession();
    await page.getByTestId('session-create').click();
    const primaryIdentity = await primaryCreated;
    const primary = page.locator('[data-workbench-mode="window"] .lab-primary-conversation .lab-session-view');
    await expectReady(primary);
    await send(primary, primaryHistory);
    await expect(primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);

    const sideCreated = createdSession();
    await send(primary, `/side ${sideHistory}`);
    const sideIdentity = await sideCreated;
    const side = page.locator('[data-workbench-mode="window"] .lab-side-conversation .lab-session-view');
    await expect(side.locator('.agent-message-assistant').last()).toContainText(sideHistory);
    const takeControl = side.getByRole('button', { name: 'Take control', exact: true });
    if (await takeControl.isVisible()) await takeControl.click();
    await expect(side.getByTestId('prompt-input')).toBeEnabled();
    await side.getByTestId('prompt-input').fill(sideDraft);
    await selectSource(page, primary, 0, isMobile);
    await primary.getByTestId('prompt-input').fill(primaryDraft);

    const sourcePane = source === 'primary' ? primary : side;
    await selectSource(page, sourcePane, source === 'primary' ? 0 : 1, isMobile);
    const askCreated = createdSession();
    await send(sourcePane, `/ask ${askHistory}`);
    const askIdentity = await askCreated;
    const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask.locator('.agent-message-assistant').last()).toContainText(askHistory);
    await sourcePane.getByTestId('prompt-input').fill(source === 'primary' ? primaryDraft : sideDraft);
    await ask.getByTestId('prompt-input').fill(askDraft);
    const location = page.url();
    const sentBeforeReload = [...sends];
    expect(creates).toHaveLength(3);
    expect(sentBeforeReload).toHaveLength(3);
    attachments.length = 0;

    await page.reload();
    await expect(ask).toBeVisible();
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    await expect(side).toHaveCount(1);
    await expectDraft(primary.getByTestId('prompt-input'), primaryDraft);
    await expectDraft(side.getByTestId('prompt-input'), sideDraft);
    await expectDraft(ask.getByTestId('prompt-input'), askDraft);
    await expect(primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
    await expect(side.locator('.agent-message-assistant').last()).toContainText(sideHistory);
    await expect(ask.locator('.agent-message-assistant').last()).toContainText(askHistory);
    await expect(page).toHaveURL(location);
    if (!isMobile) { await expect(primary).toBeVisible(); await expect(side).toBeVisible(); }
    await expect.poll(() => new Set(attachments)).toEqual(new Set([primaryIdentity.nativeSessionId, sideIdentity.nativeSessionId, askIdentity.nativeSessionId]));
    expect(attachments.filter(id => id === askIdentity.nativeSessionId)).toHaveLength(1);
    expect(creates).toHaveLength(3);
    expect(sends).toEqual(sentBeforeReload);
  });
}

async function openSideFixture(page: Page, isMobile: boolean) {
  const attachments: string[] = [];
  const sends: string[] = [];
  const creates: unknown[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/attach')) attachments.push(request.postDataJSON().nativeSessionId);
    if (path.endsWith('/create')) creates.push(request.postDataJSON());
  });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const envelope = JSON.parse(String(payload));
    const message = envelope.type === 'message' ? envelope.message : envelope;
    if (message?.type === 'send_message') sends.push(JSON.stringify(message));
  }));
  const createdSession = () => page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'))
    .then(response => response.json() as Promise<{ nativeSessionId: string }>);
  await page.goto('/');
  await showNewSession(page);
  const creation = createdSession();
  await page.getByTestId('session-create').click();
  const primaryIdentity = await creation;
  const primary = page.locator('[data-workbench-mode="window"] .lab-primary-conversation .lab-session-view');
  await expectReady(primary);
  await send(primary, primaryHistory);
  await expect(primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
  const sideCreation = createdSession();
  await send(primary, `/side ${sideHistory}`);
  const sideIdentity = await sideCreation;
  const side = page.locator('[data-workbench-mode="window"] .lab-side-conversation .lab-session-view');
  await expect(side.locator('.agent-message-assistant').last()).toContainText(sideHistory);
  const takeControl = side.getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await side.getByTestId('prompt-input').fill(sideDraft);
  await selectSource(page, primary, 0, isMobile);
  await primary.getByTestId('prompt-input').fill(primaryDraft);
  await selectSource(page, side, 1, isMobile);
  const sentBeforeReload = [...sends];
  attachments.length = 0;
  return { primary, side, primaryIdentity, sideIdentity, creates, sends, sentBeforeReload, attachments };
}

test('a delayed Side snapshot does not block restoring its saved Ask native session', async ({ page, isMobile }) => {
  const fixture = await openSideFixture(page, isMobile);
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await send(fixture.side, `/ask ${askHistory}`);
  const askIdentity = await (await created).json() as { nativeSessionId: string };
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.locator('.agent-message-assistant').last()).toContainText(askHistory);
  await fixture.side.getByTestId('prompt-input').fill(sideDraft);
  await ask.getByTestId('prompt-input').fill(askDraft);
  const sentBeforeReload = [...fixture.sends];
  const location = page.url();
  fixture.attachments.length = 0;
  let holding = true;
  let snapshotStarted!: () => void;
  const snapshotHeld = new Promise<void>(resolve => { snapshotStarted = resolve; });
  const pending: (() => void)[] = [];
  const release = () => { holding = false; for (const deliver of pending.splice(0)) deliver(); };
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      const envelope = JSON.parse(String(message));
      const frame = envelope.type === 'message' ? envelope.message : envelope;
      if (holding && frame.type === 'agent_snapshot' && frame.payload.runtimeInfo.sessionId === fixture.sideIdentity.nativeSessionId) {
        pending.push(() => route.send(message));
        snapshotStarted();
      } else route.send(message);
    });
  });
  try {
    await page.reload();
    await snapshotHeld;
    await expect.poll(() => fixture.attachments.filter(id => id === askIdentity.nativeSessionId)).toHaveLength(1);
    await ask.getByRole('button', { name: 'More session actions', exact: true }).click();
    await expect(ask.getByRole('button', { name: 'Clean Ask', exact: true })).toBeEnabled();
    release();
    await expect(fixture.side.locator('.agent-message-assistant').last()).toContainText(sideHistory);
    await expect(ask.locator('.agent-message-assistant').last()).toContainText(askHistory);
    await expectDraft(fixture.side.getByTestId('prompt-input'), sideDraft);
    await expectDraft(ask.getByTestId('prompt-input'), askDraft);
    await expect(page).toHaveURL(location);
    expect(fixture.creates).toHaveLength(3);
    expect(fixture.sends).toEqual(sentBeforeReload);
  } finally { release(); }
});

test('reload does not reopen a Side that was closed before leaving the page', async ({ page, isMobile }) => {
  const fixture = await openSideFixture(page, isMobile);
  const sideId = (await savedWindow(page)).views.find(view => view.binding?.nativeSessionId === fixture.sideIdentity.nativeSessionId)!.id;
  // A visible desktop sidebar lists this Window's views itself; otherwise the floating Windows panel does.
  const sidebar = page.locator('#lab-context');
  const inSidebar = !isMobile && await sidebar.isVisible();
  const windowMode = page.locator('[data-workbench-mode="window"]');
  if (!inSidebar) await windowMode.getByRole('button', { name: 'Windows', exact: true }).click();
  const menu = inSidebar ? sidebar.locator('.lab-window-workspaces') : windowMode.getByRole('region', { name: 'Windows', exact: true });
  await menu.locator(`[data-window-view-close=${JSON.stringify(sideId)}]`).click();
  await expect.poll(async () => (await savedWindow(page)).views.some(view => view.id === sideId)).toBe(false);
  if (!inSidebar) await menu.getByRole('button', { name: 'Close Windows', exact: true }).click();
  await expect(fixture.side).toBeHidden();
  await page.reload();
  await expectDraft(fixture.primary.getByTestId('prompt-input'), primaryDraft);
  await expect(fixture.primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
  await expect(fixture.side).toHaveCount(0);
  await expect(page).toHaveURL(url => url.searchParams.get('session') === fixture.primaryIdentity.nativeSessionId);
  expect(fixture.attachments).not.toContain(fixture.sideIdentity.nativeSessionId);
  expect(fixture.creates).toHaveLength(2);
  expect(fixture.sends).toEqual(fixture.sentBeforeReload);
});

for (const choice of ['primary', 'another session'] as const) {
  test(`a delayed Side restoration does not override a user selecting ${choice}`, async ({ page, isMobile }) => {
    const fixture = await openSideFixture(page, isMobile);
    let release!: () => void, started!: () => void, finished!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const requestFinished = new Promise<void>(resolve => { finished = resolve; });
    let holding = true;
    await page.route('**/v1/remote/attach', async route => {
      if (!holding || route.request().postDataJSON().nativeSessionId !== fixture.sideIdentity.nativeSessionId) return route.continue();
      holding = false;
      const response = await route.fetch();
      started();
      await held;
      try { await route.fulfill({ response }); }
      catch { /* The selected conversation can cancel this intercepted request. */ }
      finally { finished(); }
    });
    await page.reload();
    await requestStarted;
    await expect(fixture.primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
    if (choice === 'primary') {
      await fixture.primary.locator('.agent-message-assistant').last().click();
      await expect(page).toHaveURL(url => url.searchParams.get('session') === fixture.primaryIdentity.nativeSessionId);
    } else {
      // Opening a session binds the selected view, which the fixture left on the Side; select the main view so the chosen session replaces the composition.
      await fixture.primary.getByTestId('prompt-input').click();
      const directory = (await showAllSessions(page)).getByRole('region', { name: 'Discover sessions', exact: true });
      const refresh = directory.getByRole('button', { name: 'Refresh', exact: true });
      const welcome = directory.locator('.lab-session-row').filter({ has: page.getByText('Recorded welcome session', { exact: true }) });
      await refresh.click();
      await expect(refresh).toBeEnabled();
      while (await welcome.count() === 0) {
        await directory.getByRole('button', { name: 'Load more sessions', exact: true }).click();
        await expect(refresh).toBeEnabled();
      }
      await welcome.click();
      await expect(page).not.toHaveURL(url => [fixture.primaryIdentity.nativeSessionId, fixture.sideIdentity.nativeSessionId].includes(url.searchParams.get('session') ?? ''));
      await expect(fixture.primary.getByTestId('timeline')).not.toContainText(primaryHistory);
    }
    const chosenUrl = page.url();
    const chosenWindow = await savedWindow(page);
    const selectedSide = chosenWindow.views.find(view => view.binding?.nativeSessionId === fixture.sideIdentity.nativeSessionId);
    expect(chosenWindow.selectedViewId).not.toBe(selectedSide?.id);
    release();
    await requestFinished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(chosenUrl);
    await expect.poll(async () => {
      const current = await savedWindow(page);
      return { selectedViewId: current.selectedViewId, selectedPrimaryViewId: current.selectedPrimaryViewId, memberships: memberships(current) };
    }).toEqual({ selectedViewId: chosenWindow.selectedViewId, selectedPrimaryViewId: chosenWindow.selectedPrimaryViewId, memberships: memberships(chosenWindow) });
    if (choice === 'primary' && isMobile) await expect(fixture.side).toBeHidden();
    if (choice === 'primary' && !isMobile) await expect(fixture.side).toBeVisible();
    if (choice === 'primary') await expectDraft(fixture.primary.getByTestId('prompt-input'), primaryDraft);
    else await expect(fixture.primary.getByTestId('timeline')).not.toContainText(primaryHistory);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.sends).toEqual(fixture.sentBeforeReload);
  });
}

test('refresh during an unavailable Side restoration retains its composition and retries the same native session', async ({ page, isMobile }) => {
  const fixture = await openSideFixture(page, isMobile);
  const location = page.url();
  let unavailable = true;
  await page.route('**/v1/remote/attach', async route => {
    if (unavailable && route.request().postDataJSON().nativeSessionId === fixture.sideIdentity.nativeSessionId) {
      await route.fulfill({ status: 503, json: { error: 'Recorded Side temporarily unavailable' } });
    } else await route.continue();
  });
  await page.reload();
  // A Side is an attached Window pane: it keeps its place and shows why it could not reopen.
  await expect(fixture.side.getByRole('alert')).toContainText('Recorded Side temporarily unavailable');
  await expectDraft(fixture.primary.getByTestId('prompt-input'), primaryDraft);
  await expect(fixture.side).toHaveCount(1);
  expect(fixture.attachments.filter(id => id === fixture.sideIdentity.nativeSessionId)).toHaveLength(1);
  unavailable = false;
  await page.reload();
  await expect(fixture.side).toBeVisible();
  await expectDraft(fixture.side.getByTestId('prompt-input'), sideDraft);
  await expectDraft(fixture.primary.getByTestId('prompt-input'), primaryDraft);
  await expect(fixture.side.locator('.agent-message-assistant').last()).toContainText(sideHistory);
  await expect(page).toHaveURL(location);
  expect(fixture.attachments.filter(id => id === fixture.sideIdentity.nativeSessionId)).toHaveLength(2);
  expect(fixture.creates).toHaveLength(2);
  expect(fixture.sends).toEqual(fixture.sentBeforeReload);
});

test('a terminal nested Side failure preserves the saved path without moving focus to its parent', async ({ page, isMobile }) => {
  const fixture = await openSideFixture(page, isMobile);
  const nestedHistory = 'Keep the nested composition history';
  const nestedCreated = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await send(fixture.side, `/side ${nestedHistory}`);
  const identity = await (await nestedCreated).json() as { nativeSessionId: string };
  const middle = page.locator('[data-workbench-mode="window"] .lab-side-conversation .lab-session-view').filter({ has: page.locator('.agent-message-assistant').filter({ hasText: sideHistory }) });
  const nested = page.locator('[data-workbench-mode="window"] .lab-side-conversation .lab-session-view').filter({ has: page.locator('.agent-message-assistant').filter({ hasText: nestedHistory }) });
  await expect(nested.locator('.agent-message-assistant').last()).toContainText(nestedHistory);
  const location = page.url();
  const sentBeforeReload = [...fixture.sends];
  let unavailable = true;
  await page.route('**/v1/remote/attach', async route => {
    if (unavailable && route.request().postDataJSON().nativeSessionId === identity.nativeSessionId) {
      await route.fulfill({ status: 403, json: { error: 'Recorded nested Side is unavailable' } });
    } else await route.continue();
  });
  await page.reload();
  // The nested Side keeps its pane and shows why it could not reopen.
  await expect(nested.getByRole('alert')).toContainText('Recorded nested Side is unavailable');
  await expect(middle.locator('.agent-message-assistant').last()).toContainText(sideHistory);
  await expect(page).toHaveURL(location);
  await expect(nested).toHaveCount(1);
  unavailable = false;
  await page.reload();
  await expect(nested).toBeVisible();
  await expectDraft(middle.getByTestId('prompt-input'), '');
  await expect(page).toHaveURL(location);
  expect(fixture.creates).toHaveLength(3);
  expect(fixture.sends).toEqual(sentBeforeReload);
});

for (const keepOpened of [false, true]) {
  test(`restored native bindings keep their drafts when the opened list is ${keepOpened ? 'stale' : 'absent'}`, async ({ page, isMobile }) => {
    const fixture = await openSideFixture(page, isMobile);
    // The legacy path-shaped composition is imported once (session-composition.test.ts). Today the Window and composition
    // documents bind views by native session and key drafts by view, so the opened list's agent ids are only a catalogue
    // that may be missing or stale after the Host gave the sessions new agents.
    await page.evaluate(keepOpened => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      const openedKey = Object.keys(localStorage).find(key => key.startsWith('agent-remote-opened:'))!;
      if (!keepOpened) localStorage.removeItem(openedKey);
      else {
        const opened = JSON.parse(localStorage.getItem(openedKey)!) as Array<{ agentId: string }>;
        for (const [index, item] of opened.entries()) item.agentId = `previous-binding-${index}`;
        localStorage.setItem(openedKey, JSON.stringify(opened));
      }
    }, keepOpened);
    await page.reload();
    await expect(fixture.side).toBeVisible();
    await expectDraft(fixture.primary.getByTestId('prompt-input'), primaryDraft);
    await expectDraft(fixture.side.getByTestId('prompt-input'), sideDraft);
    await expect(fixture.primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
    await expect(fixture.side.locator('.agent-message-assistant').last()).toContainText(sideHistory);
    expect(new Set(fixture.attachments)).toEqual(new Set([fixture.primaryIdentity.nativeSessionId, fixture.sideIdentity.nativeSessionId]));
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.sends).toEqual(fixture.sentBeforeReload);
  });
}

for (const action of ['focus', 'Ask'] as const) {
  test(`a cached primary ${action} action preserves its pending native attachment`, async ({ page }) => {
    const fixture = await sessionLinkFixture({ automaticSignIn: true });
    let release: (() => void) | undefined;
    try {
      await page.goto(fixture.url);
      await page.getByRole('link', { name: 'Sign in' }).click();
      await selectConnectedHost(page, fixture.hostId);
      await showNewSession(page);
      const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
      await page.getByTestId('session-create').click();
      const identity = await (await created).json() as { nativeSessionId: string };
      const primary = page.locator('[data-workbench-mode="window"] .lab-primary-conversation .lab-session-view');
      await expectReady(primary);
      await send(primary, primaryHistory);
      await expect(primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
      await send(primary, '/ask');
      await primary.getByTestId('prompt-input').fill(primaryDraft);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.endsWith(':workspace')))).toBe(true);
      let started!: () => void;
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const attachments: string[] = [];
      await page.route('**/v1/remote/hosts/*/attach', async route => {
        if (route.request().postDataJSON().nativeSessionId !== identity.nativeSessionId) return route.continue();
        attachments.push(identity.nativeSessionId);
        const response = await route.fetch();
        started();
        await held;
        try { await route.fulfill({ response }); }
        catch { /* A regression can cancel the root while this response is held. */ }
      });
      // After a reload the coordinator reuses a primary the activity channel already reports ready instead of attaching
      // it again (665197c5). Which arrives first is a race, so hold activity until the attachment is released: the root
      // then has to attach, which is the pending native attachment this test protects.
      const activity: Array<() => void> = [];
      let holdingActivity = true;
      void held.then(() => { holdingActivity = false; for (const deliver of activity.splice(0)) deliver(); });
      await page.routeWebSocket(/\/v1\/session-channel\?observation=activity/, route => {
        const server = route.connectToServer();
        server.onMessage(message => { if (holdingActivity) activity.push(() => route.send(message)); else route.send(message); });
      });
      await page.reload();
      await requestStarted;
      await expect(primary.locator('.agent-message-assistant').last()).toContainText(primaryHistory);
      await expectDraft(primary.getByTestId('prompt-input'), primaryDraft);
      if (action === 'focus') await primary.locator('.agent-message-assistant').last().click();
      else await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
      release!();
      await expect(page.getByTestId('connection-summary')).toContainText('Ready');
      if (action === 'Ask') {
        const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
        await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
        await expect(ask).toBeHidden();
      }
      const takeControl = primary.getByRole('button', { name: 'Take control', exact: true });
      if (await takeControl.isVisible()) await takeControl.click();
      await send(primary, 'The primary connection survived cached selection');
      await expect(primary.locator('.agent-message-assistant').last()).toContainText('The primary connection survived cached selection');
      await expect(page).toHaveURL(url => url.searchParams.get('session') === identity.nativeSessionId);
      // The action kept the one pending attachment instead of cancelling it and attaching again.
      expect(attachments).toEqual([identity.nativeSessionId]);
    } finally { release?.(); await fixture.close(); }
  });
}
