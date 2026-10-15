import { expect, test, type Page } from '@playwright/test';
import { runWindowCommand } from '../../agent-host/src/window-command.js';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';
import { compositionMetadataKey, createAskOwner, createCompositionDocument, createCompositionSlot, type CompositionDocument } from '../src/session-composition.js';
import { bindWindowCompositionSlot } from '../src/window-composition.js';

async function openWindows(page: Page) {
  const trigger = page.getByRole('button', { name: 'Windows', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  return page.locator('.lab-window-panel');
}

async function openWindowOptions(panel: ReturnType<Page['locator']>) {
  const options = panel.locator('.lab-window-options');
  if (!await options.evaluate(element => element.hasAttribute('open'))) await options.locator('summary').first().click();
}

test('two pages share Window UI edits and external commands across narrow presentation', async ({ page, context }) => {
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let second: Awaited<ReturnType<typeof context.newPage>> | undefined;
  try {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId);
    await showNewSession(page); await page.getByTestId('session-create').click();
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
    const menu = await openWindows(page);
    await expect(menu.locator('[data-window-id][aria-current="true"]')).toBeVisible();
    const windowId = (await menu.locator('[data-window-id][aria-current="true"]').getAttribute('data-window-id'))!;
    const address = new URL(page.url()); address.searchParams.set('window', windowId);
    second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.setViewportSize({ width: 1680, height: 1000 });
    await second.goto(address.href);
    await openWindows(second);
    await expect(second.locator(`[data-window-id="${windowId}"]`)).toHaveAttribute('aria-current', 'true');
    const access = await (await context.request.get(fixture.url + '/auth/status')).json();
    const endpoint = `${fixture.url}${access.basePath}v1/windows/${encodeURIComponent(windowId)}`;
    const inspect = async (): Promise<WorkspaceWindow> => {
      const response = await context.request.get(endpoint);
      expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true); return (await response.json()).window;
    };
    await expect.poll(async () => !!(await inspect()).views.find(view => view.placement === 'primary')?.binding).toBe(true);
    const primary = page.locator('.lab-primary-conversation');
    await primary.getByTestId('prompt-input').fill('Draft kept when renaming this Window');
    const creations: string[] = [];
    context.on('request', request => {
      if (request.method() === 'POST' && /\/(?:windows|create)$/.test(new URL(request.url()).pathname)) creations.push(request.url());
    });
    await second.locator('.lab-primary-conversation').getByTestId('prompt-input').fill('Second page retained draft');
    await second.reload();
    await expect(second.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
    expect(new URL(second.url()).searchParams.get('window')).toBe(windowId);
    await expect(second.locator('.lab-primary-conversation').getByTestId('prompt-input')).toHaveText('Second page retained draft');
    await openWindows(second);
    await expect(primary.getByTestId('prompt-input')).toHaveText('Draft kept when renaming this Window');
    expect(creations).toEqual([]);
    const manager = (await inspect()).views.find(view => view.placement === 'primary')!.binding!;
    const assigned = await context.request.post(endpoint + '/manager', { headers: { origin: fixture.url }, data: { session: manager } });
    expect(assigned.ok(), `${assigned.status()} ${await assigned.text()}`).toBe(true);
    const grant = await assigned.json();
    const command = async (args: string[]) => {
      let output = '';
      const code = await runWindowCommand(args, { AGENT_WINDOW_SERVER: fixture.url, AGENT_WINDOW_ID: windowId, AGENT_WINDOW_TOKEN: grant.token }, text => { output += text; });
      const result = JSON.parse(output);
      expect(code, result.code ?? result.result?.code).toBe(0);
      expect(result.result.status).toBe('committed');
      return result;
    };
    // Browser actions commit through the same service observed by the other page.
    await openWindows(page);
    await openWindowOptions(menu);
    await menu.getByRole('button', { name: 'Rename Window', exact: true }).click();
    await menu.getByLabel('Window title').fill('Shared browser workspace');
    await menu.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(second.locator('[data-window-id][aria-current="true"]')).toContainText('Shared browser workspace');
    await menu.getByRole('button', { name: 'Close Windows', exact: true }).click();
    await second.getByRole('button', { name: 'Close Windows', exact: true }).click();
    await page.locator('.lab-session-dock-add').click();
    await expect(second.locator('[data-view-id]')).toHaveCount(1);
    const viewId = (await inspect()).views.find(view => view.id !== 'main' && !view.attachedTo)!.id;
    const pane = page.locator(`[data-dock-id="${viewId}"]`);
    const otherPane = second.locator(`[data-dock-id="${viewId}"]`);
    await expect(pane).toBeVisible();
    await pane.getByRole('separator').press('ArrowRight');
    await expect(otherPane.getByRole('separator')).toHaveAttribute('aria-valuenow', '450');
    // The real Controller command uses the explicitly assigned manager grant over HTTP.
    const native = await context.request.post(`${fixture.url}${access.basePath}v1/remote/hosts/${encodeURIComponent(fixture.hostId)}/create`, {
      headers: { origin: fixture.url }, data: { providerId: 'recorded', operationId: crypto.randomUUID() },
    });
    expect(native.ok()).toBe(true);
    const bound = await native.json();
    await command(['view', 'bind', windowId, viewId, '--session', JSON.stringify({ hostId: fixture.hostId, providerId: 'recorded', nativeSessionId: bound.nativeSessionId, title: 'Shared dock session' })]);
    await expect(pane.getByTestId('prompt-input')).toBeEnabled();
    await expect(otherPane.getByTestId('prompt-input')).toBeEnabled();
    await command(['view', 'resize', windowId, viewId, '--width', '620']);
    await expect(pane.getByRole('separator')).toHaveAttribute('aria-valuenow', '620');
    await expect(otherPane.getByRole('separator')).toHaveAttribute('aria-valuenow', '620');
    await command(['minimize', windowId, '--value', 'true']);
    await expect(page.locator('.lab-session-dock-base')).toHaveAttribute('data-minimized', 'true');
    await expect(second.locator('.lab-session-dock-base')).toHaveAttribute('data-minimized', 'true');
    await command(['minimize', windowId, '--value', 'false']);
    await command(['view', 'select', windowId, viewId]);
    await second.setViewportSize({ width: 390, height: 844 });
    await expect(second.locator(`[data-view-id="${viewId}"]`)).toBeVisible();
    await expect(second.locator('.lab-session-dock-add')).toHaveCount(0);
    await expect(second.locator('.lab-ordinary-workspace')).toBeHidden();
    expect((await inspect()).views.find(view => view.id === viewId)?.width).toBe(620);
    await second.setViewportSize({ width: 1680, height: 1000 });
    await expect(otherPane.getByRole('separator')).toHaveAttribute('aria-valuenow', '620');
    await command(['view', 'select', windowId, (await inspect()).primaryViewId]);
    await primary.getByTestId('prompt-input').fill('/side Shared attached conversation');
    await primary.getByTestId('prompt-input').press('Enter');
    await expect(page.locator('.lab-side-conversation:visible .agent-message-assistant').last()).toContainText('Shared attached conversation');
    await expect.poll(async () => (await inspect()).views.some(view => !!view.attachedTo)).toBe(true);
    const child = (await inspect()).views.find(view => !!view.attachedTo)!;
    await command(['view', 'select', windowId, child.id]);
    await second.setViewportSize({ width: 390, height: 844 });
    await expect(second.locator('.lab-side-conversation:visible').getByTestId('prompt-input')).toBeEnabled();
    await expect(second.locator('.lab-primary-conversation')).toBeHidden();
    expect((await inspect()).selectedViewId).toBe(child.id);
    await second.setViewportSize({ width: 1680, height: 1000 });
    await command(['view', 'bind', windowId, (await inspect()).primaryViewId, '--session', JSON.stringify({ hostId: fixture.hostId, providerId: 'recorded', nativeSessionId: bound.nativeSessionId, title: 'Different main' })]);
    await expect.poll(async () => (await inspect()).views.some(view => view.id === child.id)).toBe(false);
    await expect(page.locator('.lab-side-conversation:visible')).toHaveCount(0);
    await expect(second.locator('.lab-side-conversation:visible')).toHaveCount(0);
    await expect(primary.getByTestId('prompt-input')).toBeEnabled();
    await expect(second.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
    await expect(pane).toBeVisible(); await expect(otherPane).toBeVisible();
    await otherPane.getByRole('button', { name: 'Close Shared dock session', exact: true }).click();
    await expect(page.locator('[data-view-id]')).toHaveCount(0);
    await expect.poll(async () => (await inspect()).views.some(view => view.id === viewId)).toBe(false);
    const nativeCreatesBeforeDelete = creations.filter(url => new URL(url).pathname.endsWith('/create')).length;
    await openWindows(page);
    await menu.getByRole('button', { name: 'New Window', exact: true }).click();
    const current = menu.locator('[data-window-id][aria-current="true"]');
    await expect(current).not.toHaveAttribute('data-window-id', windowId);
    const nextId = (await current.getAttribute('data-window-id'))!;
    const createsBeforeDelete = creations.length;
    await menu.locator(`[data-window-id="${windowId}"]`).locator('..').getByRole('button', { name: 'Delete Window: Shared browser workspace', exact: true }).click();
    await expect(menu.locator(`[data-window-id="${windowId}"]`)).toHaveCount(0);
    await expect(second.getByText('Window deleted', { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('window')).toBe(nextId);
    expect(new URL(second.url()).searchParams.get('window')).toBe(windowId);
    await expect.poll(async () => (await context.request.get(endpoint)).status()).toBe(404);
    expect(creations).toHaveLength(createsBeforeDelete);
    expect(creations.filter(url => new URL(url).pathname.endsWith('/create'))).toHaveLength(nativeCreatesBeforeDelete);
    expect(errors).toEqual([]);
  } finally { await second?.close(); await page.close(); await fixture.close(); }
});


test('a fresh page restores an opening Ask, shares close and reopen, and survives reload', async ({ page, context }) => {
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  let second: Awaited<ReturnType<typeof context.newPage>> | undefined;
  let releaseAsk: (() => void) | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId);
    await showNewSession(page); await page.getByTestId('session-create').click();
    const primary = page.locator('.lab-primary-conversation');
    await expect(primary.getByTestId('prompt-input')).toBeEnabled();
    const askCreation = new Promise<void>(resolve => { releaseAsk = resolve; });
    await page.route('**/create', async route => { await askCreation; await route.continue(); });
    const initialAskRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/create'));
    await primary.getByTestId('prompt-input').fill('/ask Shared Ask question');
    await primary.getByTestId('prompt-input').press('Enter');
    const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('status').filter({ hasText: 'Opening Ask' })).toBeVisible();
    await initialAskRequest;
    const windowId = new URL(page.url()).searchParams.get('window');
    expect(windowId).toBeTruthy();
    const creations: string[] = [];
    context.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations.push(request.url()); });
    const originalLocal = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.endsWith(':composition-v2'))!;
      return JSON.parse(sessionStorage.getItem(key)!) as CompositionDocument;
    });
    const originalSource = originalLocal.slots.find(slot => slot.id === originalLocal.primary)!;
    const source = { hostId: originalSource.intent.target.hostId, ...originalSource.intent.target.native, title: 'Independent local source' };
    const localSource = createCompositionSlot(`second-page-source:${crypto.randomUUID()}`, source, originalLocal.scope);
    const independentLocal = createCompositionDocument(originalLocal.scope, [localSource]);
    independentLocal.asks.push(createAskOwner(localSource, independentLocal.scope));
    const primaryViewId = originalLocal.windowBindings!.find(binding => binding.slotId === originalSource.id && binding.windowId === windowId)!.viewId;
    bindWindowCompositionSlot(independentLocal, windowId!, primaryViewId, source, localSource.id);
    second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.addInitScript(({ key, document }) => {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify(document));
    }, { key: compositionMetadataKey(independentLocal.scope), document: independentLocal });
    await second.setViewportSize({ width: 1680, height: 1000 });
    await second.goto(page.url());
    const otherAsk = second.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(otherAsk).toBeVisible();
    releaseAsk!();
    await expect(ask.locator('.agent-message-assistant').last()).toContainText('Shared Ask question');
    await expect(otherAsk.getByTestId('prompt-input')).toBeEnabled();
    await expect(otherAsk.locator('.agent-message-assistant').last()).toContainText('Shared Ask question');
    expect(new URL(second.url()).searchParams.get('window')).toBe(windowId);
    const owners = async (target: typeof page) => target.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.endsWith(':composition-v2'));
      return key ? JSON.parse(sessionStorage.getItem(key)!) : undefined;
    });
    const firstLocal = await owners(page), secondLocal = await owners(second);
    expect(firstLocal?.slots?.length).toBeGreaterThan(0); expect(secondLocal?.slots?.length).toBeGreaterThan(0);
    expect(secondLocal.slots.map((slot: { id: string }) => slot.id)).not.toEqual(firstLocal.slots.map((slot: { id: string }) => slot.id));
    expect(secondLocal.primary).toBe(localSource.id);
    expect(secondLocal.asks.find((owner: { sourceSlot: string }) => owner.sourceSlot === localSource.id)?.id).toBe(independentLocal.asks[0]!.id);
    expect(firstLocal.asks.map((owner: { id: string }) => owner.id)).not.toContain(independentLocal.asks[0]!.id);
    await otherAsk.getByRole('button', { name: 'Minimize Ask' }).click();
    await expect(ask).toHaveCount(0); await expect(otherAsk).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    await expect(otherAsk.getByTestId('prompt-input')).toBeEnabled();
    await second.reload();
    await expect(otherAsk.getByTestId('prompt-input')).toBeEnabled();
    await expect(otherAsk.locator('.agent-message-assistant').last()).toContainText('Shared Ask question');
    expect(new URL(second.url()).searchParams.get('window')).toBe(windowId);
    expect(creations).toEqual([]);
    expect(errors).toEqual([]);
  } finally { releaseAsk?.(); await second?.close(); await page.close(); await fixture.close(); }
});

for (const width of [320, 390]) test(`floating Window management remains usable at ${width}px`, async ({ page }) => {
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width, height: 667 });
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId);
    await showNewSession(page); await page.getByTestId('session-create').click();
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
    const trigger = page.getByRole('button', { name: 'Windows', exact: true });
    const panel = await openWindows(page);
    if (width === 390) await page.screenshot({ path: `/tmp/window-menu-${test.info().project.name}-390.png` });
    const currentWindow = panel.locator('[data-window-id][aria-current="true"]');
    const first = (await currentWindow.getAttribute('data-window-id'))!;
    const title = 'A long Window title keeps the current workspace readable on a narrow phone screen';
    await openWindowOptions(panel);
    await panel.getByRole('button', { name: 'Rename Window', exact: true }).click();
    await panel.getByLabel('Window title', { exact: true }).fill(title);
    const bounds = async () => panel.evaluate(element => {
      const box = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll('[data-window-row], [data-window-id], [data-window-view-id], input')).map(control => {
        const rect = control.getBoundingClientRect();
        return { label: control.hasAttribute('data-window-row') || control.hasAttribute('data-window-view-id') ? 'list item' : control.getAttribute('aria-label'), left: rect.left, right: rect.right, width: rect.width };
      });
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, controls, pageWidth: document.documentElement.scrollWidth };
    });
    let measured = await bounds();
    expect(measured.left).toBeGreaterThanOrEqual(0); expect(measured.right).toBeLessThanOrEqual(width);
    expect(measured.top).toBeGreaterThanOrEqual(0); expect(measured.bottom).toBeLessThanOrEqual(667);
    for (const control of measured.controls) {
      expect(control.left).toBeGreaterThanOrEqual(measured.left);
      expect(control.right).toBeLessThanOrEqual(measured.right);
      if (control.label === 'list item') expect(control.width).toBeGreaterThanOrEqual((measured.right - measured.left) * .85);
    }
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(currentWindow).toContainText(title);
    measured = await bounds();
    expect(measured.pageWidth).toBe(width);
    for (const control of measured.controls) expect(control.right).toBeLessThanOrEqual(measured.right);
    await panel.getByRole('button', { name: 'New Window', exact: true }).click();
    await expect(currentWindow).not.toHaveAttribute('data-window-id', first);
    const second = (await currentWindow.getAttribute('data-window-id'))!;
    await panel.locator(`[data-window-id="${first}"]`).click();
    await expect(currentWindow).toHaveAttribute('data-window-id', first);
    await expect(currentWindow).toContainText(title);
    expect(new URL(page.url()).searchParams.get('window')).toBe(first);
    await panel.locator('[data-window-view-id="main"]').click();
    await openWindowOptions(panel);
    const agentControl = panel.getByText('Agent control', { exact: true });
    await agentControl.click();
    const revoke = panel.getByRole('button', { name: 'Revoke manager', exact: true });
    await revoke.scrollIntoViewIfNeeded();
    await expect(revoke).toBeInViewport();
    if (width === 390) await page.screenshot({ path: `/tmp/window-menu-${test.info().project.name}-390-options.png` });
    measured = await bounds();
    expect(measured.bottom).toBeLessThanOrEqual(667);
    expect(measured.pageWidth).toBe(width);
    await panel.locator(`[data-window-id="${second}"]`).click();
    await expect(currentWindow).toHaveAttribute('data-window-id', second);
    await panel.getByRole('button', { name: 'Close Windows', exact: true }).click();
    // Dragging uses the same viewport clamping as the existing Team control.
    const before = await trigger.boundingBox(); expect(before).not.toBeNull();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down(); await page.mouse.move(1, 1, { steps: 8 }); await page.mouse.up();
    await expect(panel).toBeHidden();
    let dragged = await trigger.boundingBox();
    expect(dragged!.x).toBeGreaterThanOrEqual(11); expect(dragged!.y).toBeGreaterThanOrEqual(11);
    await page.mouse.move(dragged!.x + dragged!.width / 2, dragged!.y + dragged!.height / 2);
    await page.mouse.down(); await page.mouse.move(width - 1, 666, { steps: 8 }); await page.mouse.up();
    dragged = await trigger.boundingBox();
    expect(dragged!.x + dragged!.width).toBeLessThanOrEqual(width - 11);
    expect(dragged!.y + dragged!.height).toBeLessThanOrEqual(656);
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    const visibility = page.getByRole('checkbox', { name: 'Window view', exact: true });
    await visibility.uncheck(); await expect(trigger).toBeHidden();
    await visibility.check(); await expect(trigger).toBeVisible();
    await page.getByRole('region', { name: 'View options', exact: true }).press('Escape');
    await openWindows(page);
    expect(errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('active Windows cannot be deleted and deleting another Window never creates or selects a replacement', async ({ page, context }) => {
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  let second: Page | undefined;
  try {
    await page.setViewportSize({ width: 390, height: 667 });
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId);
    await showNewSession(page); await page.getByTestId('session-create').click();
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeEnabled();
    const panel = await openWindows(page);
    const current = panel.locator('[data-window-id][aria-current="true"]');
    await expect(current).toBeVisible();
    const existingId = (await current.getAttribute('data-window-id'))!;
    await openWindowOptions(panel);
    await panel.getByRole('button', { name: 'Rename Window', exact: true }).click();
    await panel.getByLabel('Window title').fill('Existing workspace');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(current).toContainText('Existing workspace');
    await panel.getByRole('button', { name: 'New Window', exact: true }).click();
    await expect(current).not.toHaveAttribute('data-window-id', existingId);
    const deletedId = (await current.getAttribute('data-window-id'))!;
    const access = await (await context.request.get(fixture.url + '/auth/status')).json();
    const endpoint = `${fixture.url}${access.basePath}v1/windows`;
    const snapshot = (await (await context.request.get(`${endpoint}/${deletedId}`)).json()).window as WorkspaceWindow;
    const emptied = await context.request.post(`${endpoint}/${deletedId}/operations`, { headers: { origin: fixture.url }, data: {
      operationId: crypto.randomUUID(), issuedAt: Date.now(), baseRevision: snapshot.revision,
      operation: { type: 'layout.apply', layout: { title: 'Window', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] } },
    } });
    expect(emptied.ok(), await emptied.text()).toBe(true);
    await expect(panel.locator('[data-window-view-id="main"]')).toContainText('Empty view');
    second = await context.newPage(); await second.setViewportSize({ width: 390, height: 667 });
    await second.goto(page.url());
    const otherPanel = await openWindows(second);
    await expect(otherPanel.locator(`[data-window-id="${deletedId}"]`)).toHaveAttribute('aria-current', 'true');
    const catalog = async () => (await (await context.request.get(endpoint)).json()).windows as WorkspaceWindow[];
    const before = await catalog();
    expect(before.map(window => window.id).sort()).toEqual([existingId, deletedId].sort());
    await panel.locator(`[data-window-id="${existingId}"]`).click();
    await expect(current).toHaveAttribute('data-window-id', existingId);
    await expect(panel.getByRole('button', { name: 'Delete Window: Existing workspace', exact: true })).toBeDisabled();
    await expect(otherPanel.getByRole('button', { name: 'Delete Window: Window', exact: true })).toBeDisabled();
    await page.screenshot({ path: `/tmp/window-delete-${test.info().project.name}-list.png` });
    await openWindowOptions(panel);
    await expect(panel.locator('.lab-window-options').getByRole('button', { name: 'Delete Window', exact: true })).toHaveCount(0);
    const requests: Array<{ method: string; path: string }> = [];
    context.on('request', request => { const path = new URL(request.url()).pathname; if (path.includes('/windows') && request.method() !== 'GET') requests.push({ method: request.method(), path }); });
    await panel.getByRole('button', { name: 'Delete Window: Window', exact: true }).click();
    await expect.poll(async () => (await catalog()).map(window => window.id)).toEqual([existingId]);
    await expect(second.getByText('Window deleted', { exact: true })).toBeVisible();
    const recoveryDeletes = second.locator('.lab-window-unavailable button[aria-label^="Delete Window:"]');
    await expect(recoveryDeletes).toHaveCount(1);
    for (const button of await recoveryDeletes.all()) await expect(button).toBeDisabled();
    const recovery = second.locator('.lab-window-recovery[data-deleted="true"]');
    await recovery.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    await expect(recovery).toHaveCSS('opacity', '1');
    await expect(recovery).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    await second.screenshot({ path: `/tmp/window-delete-${test.info().project.name}-notice.png` });
    await expect(current).toHaveAttribute('data-window-id', existingId);
    expect(new URL(page.url()).searchParams.get('window')).toBe(existingId);
    expect(new URL(second.url()).searchParams.get('window')).toBe(deletedId);
    expect(requests.filter(request => request.method === 'POST')).toEqual([]);
    // A deleted page recovers only after an explicit user choice.
    await second.locator(`.lab-window-unavailable [data-window-id="${existingId}"]`).click();
    await openWindows(second);
    await expect(otherPanel.locator('[data-window-id][aria-current="true"]')).toHaveAttribute('data-window-id', existingId);
    await expect(second.getByText('Window deleted', { exact: true })).toHaveCount(0);
    await expect(otherPanel.getByRole('button', { name: 'Delete Window: Existing workspace', exact: true })).toBeDisabled();
    expect(new URL(second.url()).searchParams.get('window')).toBe(existingId);
    expect(requests.filter(request => request.method === 'POST')).toEqual([]);
    await otherPanel.getByRole('button', { name: 'New Window', exact: true }).click();
    const otherCurrent = otherPanel.locator('[data-window-id][aria-current="true"]');
    await expect(otherCurrent).not.toHaveAttribute('data-window-id', existingId);
    const manuallyCreatedId = (await otherCurrent.getAttribute('data-window-id'))!;
    await otherPanel.locator(`[data-window-id="${existingId}"]`).click();
    await expect(otherCurrent).toHaveAttribute('data-window-id', existingId);
    const permittedDelete = otherPanel.locator(`[data-window-id="${manuallyCreatedId}"]`).locator('..').locator('button[aria-label^="Delete Window:"]');
    await expect(permittedDelete).toBeEnabled();
    await permittedDelete.click();
    await expect.poll(async () => (await catalog()).map(window => window.id)).toEqual([existingId]);
  } finally { await second?.close(); await page.close(); await fixture.close(); }
});
