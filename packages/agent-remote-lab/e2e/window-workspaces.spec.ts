import { expect, test } from '@playwright/test';
import { runWindowCommand } from '../../agent-host/src/window-command.js';
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';
import { compositionMetadataKey, createAskOwner, createCompositionDocument, createCompositionSlot, type CompositionDocument } from '../src/session-composition.js';
import { bindWindowCompositionSlot } from '../src/window-composition.js';

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
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    const menu = page.locator('.lab-window-workspaces');
    await menu.locator('summary').click();
    await expect(menu.getByLabel('Open Window')).not.toHaveValue('');
    const windowId = await menu.getByLabel('Open Window').inputValue();
    const address = new URL(page.url()); address.searchParams.set('window', windowId);
    second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.setViewportSize({ width: 1680, height: 1000 });
    await second.goto(address.href);
    await second.getByRole('button', { name: 'View options', exact: true }).click();
    await expect(second.getByLabel('Open Window', { exact: true })).toHaveValue(windowId);
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
    await second.getByRole('button', { name: 'View options', exact: true }).click();
    await second.locator('.lab-window-workspaces summary').click();
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
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await menu.locator('summary').click();
    await menu.getByLabel('Window title').fill('Shared browser workspace');
    await menu.getByLabel('Window title').blur();
    await expect(second.locator('.lab-window-workspaces summary')).toHaveText('Window: Shared browser workspace');
    await page.getByRole('region', { name: 'View options', exact: true }).press('Escape');
    await second.getByRole('region', { name: 'View options', exact: true }).press('Escape');
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
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await menu.locator('summary').click();
    await menu.getByRole('button', { name: 'Delete Window', exact: true }).click();
    for (const target of [page, second]) {
      await expect.poll(() => new URL(target.url()).searchParams.get('window')).not.toBe(windowId);
      await expect.poll(async () => {
        const id = new URL(target.url()).searchParams.get('window');
        if (!id) return undefined;
        const response = await context.request.get(`${fixture.url}${access.basePath}v1/windows/${encodeURIComponent(id)}`);
        if (!response.ok()) return undefined;
        const replacement = (await response.json()).window as WorkspaceWindow;
        return { views: replacement.views.map(view => ({ id: view.id, binding: view.binding ?? null })) };
      }).toEqual({ views: [{ id: 'main', binding: null }] });
      await expect(target.locator('.lab-side-conversation:visible')).toHaveCount(0);
      await expect(target.locator('[data-view-id]')).toHaveCount(0);
    }
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
    await primary.getByTestId('prompt-input').fill('/ask Shared Ask question');
    await primary.getByTestId('prompt-input').press('Enter');
    const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('status').filter({ hasText: 'Opening Ask' })).toBeVisible();
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
