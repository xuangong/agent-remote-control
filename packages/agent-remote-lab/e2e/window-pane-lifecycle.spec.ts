import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createWindowView, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';

test.setTimeout(90_000);

async function openWindows(page: Page) {
  const trigger = page.getByRole('button', { name: 'Windows', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const panel = page.locator('.lab-window-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function closeWindows(page: Page) {
  const panel = page.locator('.lab-window-panel');
  if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close Windows', exact: true }).click();
}

async function closeListedView(page: Page, id: string) {
  const panel = await openWindows(page);
  await panel.locator(`[data-window-view-close="${id}"]`).click();
  await expect(panel.locator(`[data-window-view-row="${id}"]`)).toHaveCount(0);
}

async function expectGlobalView(page: Page) {
  const trigger = page.getByRole('button', { name: 'View options', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await expect(options).toBeVisible();
  await options.press('Escape');
  await expect(options).toHaveCount(0);
}

async function createWorkspace(page: Page, context: BrowserContext) {
  const fixture = await sessionLinkFixture({ automaticSignIn: true, listCreatedSessions: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Connected Host').selectOption(fixture.hostId);
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    await expect(page.locator('.lab-primary-group[data-selected="true"]').getByTestId('prompt-input')).toBeEnabled();
    const windowId = new URL(page.url()).searchParams.get('window');
    expect(windowId).toBeTruthy();
    const access = await (await context.request.get(fixture.url + '/auth/status')).json();
    const endpoint = `${fixture.url}${access.basePath}v1/windows/${encodeURIComponent(windowId!)}`;
    const inspect = async (): Promise<WorkspaceWindow> => {
      const response = await context.request.get(endpoint);
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).window;
    };
    await expect.poll(async () => (await inspect()).views.some(view => !!view.binding)).toBe(true);
    const binding = (await inspect()).views.find(view => view.binding)!.binding!;
    const createNative = async (title: string): Promise<WindowSessionBinding> => {
      const response = await context.request.post(`${fixture.url}${access.basePath}v1/remote/hosts/${encodeURIComponent(fixture.hostId)}/create`, {
        headers: { origin: fixture.url }, data: { providerId: 'recorded', operationId: randomUUID() },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const created = await response.json();
      return { hostId: fixture.hostId, providerId: 'recorded', nativeSessionId: created.nativeSessionId, title };
    };
    const apply = async (views: WindowView[], selectedPrimaryViewId: string, selectedViewId = selectedPrimaryViewId) => {
      const current = await inspect();
      const response = await context.request.post(endpoint + '/operations', {
        headers: { origin: fixture.url },
        data: { operationId: randomUUID(), issuedAt: Date.now(), baseRevision: current.revision,
          operation: { type: 'layout.apply', layout: { title: current.title, selectedPrimaryViewId, selectedViewId, views } } },
      });
      expect(response.ok(), await response.text()).toBe(true);
      expect((await response.json()).result.status).toBe('committed');
      await expect.poll(async () => (await inspect()).views.map(view => view.id)).toEqual(views.map(view => view.id));
    };
    return { fixture, windowId: windowId!, binding, inspect, createNative, apply, errors,
      async close() { await page.close(); await fixture.close(); } };
  } catch (error) {
    await page.close(); await fixture.close(); throw error;
  }
}

test('closing an unselected primary removes its attached family and preserves the selected pane and independent dock', async ({ page, context }) => {
  const workspace = await createWorkspace(page, context);
  try {
    const child = await workspace.createNative('Alpha child');
    const leaf = await workspace.createNative('Alpha leaf');
    await workspace.apply([
      createWindowView('alpha', { ...workspace.binding, title: 'Alpha' }, 'primary'),
      { ...createWindowView('alpha-child', { ...child, parentNativeSessionId: workspace.binding.nativeSessionId }, 'attached'), attachedTo: 'alpha' },
      { ...createWindowView('alpha-leaf', { ...leaf, parentNativeSessionId: child.nativeSessionId }, 'attached'), attachedTo: 'alpha-child' },
      createWindowView('beta', { ...workspace.binding, title: 'Beta' }, 'primary'),
      createWindowView('independent', { ...workspace.binding, title: 'Independent' }),
    ], 'beta');
    const panel = await openWindows(page);
    await expect(panel.locator('[data-window-view-id="beta"]')).toHaveAttribute('aria-current', 'true');
    await closeListedView(page, 'alpha');
    await expect.poll(async () => (await workspace.inspect()).views.map(view => view.id)).toEqual(['beta', 'independent']);
    await expect.poll(async () => {
      const current = await workspace.inspect(); return [current.selectedPrimaryViewId, current.selectedViewId];
    }).toEqual(['beta', 'beta']);
    await expect(panel.locator('[data-window-view-id="beta"]')).toHaveAttribute('aria-current', 'true');
    await expect(panel.locator('[data-window-view-row="independent"]')).toBeVisible();
    await closeWindows(page);
    await expect(page.locator('[data-primary-group-id="alpha"]')).toHaveCount(0);
    await expect(page.locator('[data-primary-group-id="beta"]').getByTestId('prompt-input')).toBeEnabled();
    expect(workspace.errors).toEqual([]);
  } finally { await workspace.close(); }
});

test('closing the selected and final primary leaves usable independent docks and reachable global controls', async ({ page, context, isMobile }) => {
  const workspace = await createWorkspace(page, context);
  try {
    await workspace.apply([
      createWindowView('alpha', { ...workspace.binding, title: 'Alpha' }, 'primary'),
      createWindowView('beta', { ...workspace.binding, title: 'Beta' }, 'primary'),
      createWindowView('dock-one', { ...workspace.binding, title: 'Dock one' }),
      createWindowView('dock-two', { ...workspace.binding, title: 'Dock two' }),
    ], 'alpha');
    if (isMobile) await closeListedView(page, 'alpha');
    else await page.getByRole('button', { name: 'Close primary group: Alpha', exact: true }).click();
    await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe('beta');
    if (isMobile) { await closeListedView(page, 'beta'); await closeWindows(page); }
    else await page.getByRole('button', { name: 'Close primary group: Beta', exact: true }).click();
    await expect.poll(async () => (await workspace.inspect()).views.map(view => view.id)).toEqual(['dock-one', 'dock-two']);
    await expect.poll(async () => {
      const current = await workspace.inspect(); return [current.selectedPrimaryViewId, current.selectedViewId];
    }).toEqual([null, 'dock-one']);
    const first = page.locator('.lab-bindable-session-window[data-view-id="dock-one"]');
    await expect(first.getByTestId('prompt-input')).toBeEnabled();
    await first.getByTestId('prompt-input').fill('A surviving dock remains interactive');
    await expectGlobalView(page);
    if (!isMobile) {
      await first.locator('[data-session-title-draggable]').press('Alt+ArrowRight');
      await expect.poll(async () => (await workspace.inspect()).views.map(view => view.id)).toEqual(['dock-two', 'dock-one']);
      await expect.poll(async () => page.locator('[data-dock-id="dock-two"]').evaluate(element => Number((element as HTMLElement).style.order))).toBe(1);
      await first.locator('[data-session-title-draggable]').press('Alt+ArrowLeft');
      await expect.poll(async () => (await workspace.inspect()).views.map(view => view.id)).toEqual(['dock-one', 'dock-two']);
      await expect(first.getByTestId('prompt-input')).toHaveText('A surviving dock remains interactive');
    }
    const panel = await openWindows(page);
    await panel.locator('[data-window-view-id="dock-two"]').click();
    await closeWindows(page);
    await expect(page.locator('.lab-bindable-session-window[data-view-id="dock-two"]').getByTestId('prompt-input')).toBeEnabled();
    await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe('dock-two');
    expect(workspace.errors).toEqual([]);
  } finally { await workspace.close(); }
});

test('the last pane closes to a persistent empty Window that can bind an existing session again', async ({ page, context }) => {
  const workspace = await createWorkspace(page, context);
  const refreshRequests: string[] = [];
  let capturingRefresh = false;
  try {
    const created: string[] = [];
    context.on('request', request => {
      if (request.method() === 'POST' && /\/(?:windows|create)$/.test(new URL(request.url()).pathname)) created.push(request.url());
      if (capturingRefresh && /\/(?:attach|create)$/.test(new URL(request.url()).pathname)) refreshRequests.push(request.url());
    });
    const primary = (await workspace.inspect()).views.find(view => view.placement === 'primary')!;
    await closeListedView(page, primary.id);
    await expect.poll(async () => {
      const current = await workspace.inspect();
      return { views: current.views, primary: current.selectedPrimaryViewId, selected: current.selectedViewId };
    }).toEqual({ views: [], primary: null, selected: null });
    await closeWindows(page);
    await expect(page.getByTestId('empty-window')).toBeVisible();
    await expect(page.getByTestId('empty-window')).toContainText('No session views');
    await expectGlobalView(page);
    capturingRefresh = true;
    await page.reload();
    await expect(page.getByTestId('empty-window')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('window')).toBe(workspace.windowId);
    expect((await workspace.inspect()).views).toEqual([]);
    await expectGlobalView(page);
    capturingRefresh = false;
    await test.info().attach('empty-window-refresh', { body: JSON.stringify({ url: page.url(), nativeRequests: refreshRequests }, null, 2), contentType: 'application/json' });
    expect(refreshRequests).toEqual([]);
    const screenshot = test.info().outputPath('empty-window.png');
    await page.screenshot({ path: screenshot });
    await test.info().attach('empty-window-layout', { path: screenshot, contentType: 'image/png' });
    const panel = await openWindows(page);
    await expect(panel.locator(`[data-window-id="${workspace.windowId}"]`)).toHaveAttribute('aria-current', 'true');
    await expect(panel.getByRole('navigation', { name: 'Session views', exact: true }).locator('[data-window-view-id]')).toHaveCount(0);
    await closeWindows(page);
    await page.getByTestId('empty-window').getByRole('button', { name: 'New session view', exact: true }).click();
    await expect.poll(async () => (await workspace.inspect()).views.length).toBe(1);
    const empty = (await workspace.inspect()).views[0]!;
    expect(empty.binding).toBeUndefined();
    const pane = page.locator(`.lab-bindable-session-window[data-view-id="${empty.id}"]`);
    const discover = page.getByRole('region', { name: 'Discover sessions', exact: true });
    await expect(discover).toBeVisible();
    await discover.getByRole('button', { name: 'Refresh', exact: true }).click();
    const nativeKey = JSON.stringify([workspace.binding.hostId, workspace.binding.providerId, workspace.binding.nativeSessionId]);
    await discover.locator(`[data-session-key=${JSON.stringify(nativeKey)}]`).locator('.lab-session-row').first().click();
    await expect.poll(async () => (await workspace.inspect()).views.find(view => view.id === empty.id)?.binding?.nativeSessionId).toBe(workspace.binding.nativeSessionId);
    await expect(pane).toBeVisible();
    await expect(pane.getByTestId('prompt-input')).toBeEnabled();
    await pane.getByTestId('prompt-input').fill('An existing native session in the same Window');
    expect((await workspace.inspect()).views).toHaveLength(1);
    expect(new URL(page.url()).searchParams.get('window')).toBe(workspace.windowId);
    expect(created).toEqual([]);
    expect(workspace.errors).toEqual([]);
  } catch (error) {
    await test.info().attach('empty-window-state', { body: JSON.stringify({ window: await workspace.inspect(), refreshRequests, errors: workspace.errors }, null, 2), contentType: 'application/json' });
    throw error;
  } finally { await workspace.close(); }
});

test('closing an attached pane or a linked leader removes only its dependent views', async ({ page, context }) => {
  const workspace = await createWorkspace(page, context);
  try {
    const child = await workspace.createNative('Child');
    const leaf = await workspace.createNative('Leaf');
    await workspace.apply([
      createWindowView('root', { ...workspace.binding, title: 'Root' }, 'primary'),
      { ...createWindowView('child', { ...child, parentNativeSessionId: workspace.binding.nativeSessionId }, 'attached'), attachedTo: 'root' },
      { ...createWindowView('leaf', { ...leaf, parentNativeSessionId: child.nativeSessionId }, 'attached'), attachedTo: 'child' },
      createWindowView('leader', { ...workspace.binding, title: 'Linked leader' }),
      { ...createWindowView('member', { ...workspace.binding, title: 'Linked member' }), closeWith: 'leader' },
      { ...createWindowView('member-child', { ...child, parentNativeSessionId: workspace.binding.nativeSessionId }, 'attached'), attachedTo: 'member' },
      createWindowView('independent', { ...workspace.binding, title: 'Independent' }),
    ], 'root', 'leaf');
    await closeListedView(page, 'child');
    await expect.poll(async () => (await workspace.inspect()).views.map(view => view.id)).toEqual(['root', 'leader', 'member', 'member-child', 'independent']);
    await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe('root');
    await closeListedView(page, 'leader');
    await expect.poll(async () => (await workspace.inspect()).views.map(view => view.id)).toEqual(['root', 'independent']);
    await closeWindows(page);
    await expect(page.locator('[data-primary-group-id="root"]').getByTestId('prompt-input')).toBeEnabled();
    expect((await workspace.inspect()).views[0]!.binding?.nativeSessionId).toBe(workspace.binding.nativeSessionId);
    expect(workspace.errors).toEqual([]);
  } finally { await workspace.close(); }
});

for (const placement of ['primary', 'dock'] as const) {
  test(`${placement} Side footer reopens the closed attached pane beside its own source`, async ({ page, context, isMobile }) => {
    const workspace = await createWorkspace(page, context);
    let phase = 'prepare';
    try {
      const dock = await workspace.createNative('Dock source');
      const sourceId = placement === 'primary' ? 'main' : 'dock';
      await workspace.apply([
        createWindowView('main', { ...workspace.binding, title: 'Primary source' }, 'primary'),
        createWindowView('dock', dock),
      ], 'main', sourceId);
      const source = page.locator(placement === 'primary' ? '[data-primary-group-id="main"]' : '.lab-bindable-session-window[data-view-id="dock"]')
        .locator('.lab-session-family-pane').first();
      await expect(source.getByTestId('prompt-input')).toBeEnabled();
      phase = 'create side from source composer';
      await source.getByTestId('prompt-input').fill(`/side Investigate the ${placement} source`);
      await expect(source.getByTestId('prompt-submit')).toBeEnabled();
      await source.getByTestId('prompt-submit').click();
      await expect.poll(async () => (await workspace.inspect()).views.some(view => view.attachedTo === sourceId)).toBe(true);
      const side = (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)!;
      expect(side.binding?.nativeSessionId).toBeTruthy();
      phase = 'close attached side';
      await closeListedView(page, side.id);
      await expect.poll(async () => (await workspace.inspect()).views.some(view => view.attachedTo === sourceId)).toBe(false);
      const panel = await openWindows(page);
      await panel.locator(`[data-window-view-id="${sourceId}"]`).click();
      await closeWindows(page);
      const link = source.getByRole('navigation', { name: 'Forked sessions', exact: true }).getByRole('button', { name: /^Side 1 ·/ });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('aria-pressed', 'false');
      phase = 'reopen side from source footer';
      await link.click();
      await expect.poll(async () => (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)?.binding?.nativeSessionId).toBe(side.binding!.nativeSessionId);
      const reopened = (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)!;
      await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe(reopened.id);
      const shell = page.locator(placement === 'primary' ? '[data-primary-group-id="main"]' : '.lab-bindable-session-window[data-view-id="dock"]');
      await expect(shell.locator('.lab-session-family-pane').nth(1).getByTestId('prompt-input')).toBeEnabled();
      phase = 'select the existing side again without duplicating it';
      await (await openWindows(page)).locator(`[data-window-view-id="${sourceId}"]`).click();
      await closeWindows(page);
      await link.click();
      await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe(reopened.id);
      expect((await workspace.inspect()).views.filter(view => view.attachedTo === sourceId).map(view => view.id)).toEqual([reopened.id]);
      if (isMobile) {
        await (await openWindows(page)).locator(`[data-window-view-id="${sourceId}"]`).click();
        await closeWindows(page);
      }
      await expect(link).toHaveAttribute('aria-pressed', 'true');
      expect(workspace.errors).toEqual([]);
    } catch (error) {
      await test.info().attach('window-side-state', { body: JSON.stringify({ phase, window: await workspace.inspect(), errors: workspace.errors }, null, 2), contentType: 'application/json' });
      throw error;
    } finally { await workspace.close(); }
  });
}

for (const placement of ['primary', 'dock'] as const) {
  for (const savedTarget of ['missing pane', 'another session pane'] as const) {
    test(`${placement} Side footer survives refresh with a saved target pointing to ${savedTarget}`, async ({ page, context }) => {
      const workspace = await createWorkspace(page, context);
      let phase = 'prepare';
      try {
        const dock = await workspace.createNative('Dock source');
        const sourceId = placement === 'primary' ? 'main' : 'dock';
        await workspace.apply([
          createWindowView('main', { ...workspace.binding, title: 'Primary source' }, 'primary'),
          createWindowView('dock', dock),
        ], 'main', sourceId);
        const shell = page.locator(placement === 'primary' ? '[data-primary-group-id="main"]' : '.lab-bindable-session-window[data-view-id="dock"]');
        const source = shell.locator('.lab-session-family-pane').first();
        await expect(source.getByTestId('prompt-input')).toBeEnabled();
        await source.getByTestId('prompt-input').fill(`/side Preserve the ${placement} source across refresh`);
        await source.getByTestId('prompt-submit').click();
        await expect.poll(async () => (await workspace.inspect()).views.some(view => view.attachedTo === sourceId)).toBe(true);
        const side = (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)!;
        expect(side.binding?.nativeSessionId).toBeTruthy();
        await closeListedView(page, side.id);
        await (await openWindows(page)).locator(`[data-window-view-id="${sourceId}"]`).click();
        await closeWindows(page);
        await expect(source.getByTestId('prompt-input')).toBeEnabled();
        phase = 'restore a fork record saved by an older client';
        const seeded = await page.evaluate(({ nativeSessionId, windowId, sourceId, savedTarget }) => {
          const recordKey = Object.keys(localStorage).find(key => key.startsWith('agent-remote-forks:') && key.includes(':record:')
            && JSON.parse(localStorage.getItem(key)!).target?.nativeSessionId === nativeSessionId);
          if (!recordKey) throw new Error('The created Side has no saved fork record.');
          const record = JSON.parse(localStorage.getItem(recordKey)!);
          const documents = Object.keys(sessionStorage).filter(key => key.endsWith(':composition-v2'))
            .map(key => JSON.parse(sessionStorage.getItem(key)!));
          const sourceSlot = documents.flatMap(document => document.windowBindings ?? [])
            .find((binding: { windowId: string; viewId: string }) => binding.windowId === windowId && binding.viewId === sourceId)?.slotId;
          if (!sourceSlot) throw new Error('The source pane has no saved composition binding.');
          record.target.viewId = savedTarget === 'missing pane' ? 'removed-window-pane' : sourceSlot;
          localStorage.setItem(recordKey, JSON.stringify(record));
          return { targetViewId: record.target.viewId, sourceSlot };
        }, { nativeSessionId: side.binding!.nativeSessionId, windowId: workspace.windowId, sourceId, savedTarget });
        expect(seeded.targetViewId).toBe(savedTarget === 'missing pane' ? 'removed-window-pane' : seeded.sourceSlot);
        phase = 'reload and reopen the saved Side';
        await page.reload();
        await expect(source.getByTestId('prompt-input')).toBeEnabled();
        const link = source.getByRole('navigation', { name: 'Forked sessions', exact: true }).getByRole('button', { name: /^Side 1 ·/ });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('aria-pressed', 'false');
        const creations: string[] = [];
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/create')) creations.push(request.url());
        });
        await link.click();
        await expect.poll(async () => (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)?.binding?.nativeSessionId).toBe(side.binding!.nativeSessionId);
        const reopened = (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)!;
        await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe(reopened.id);
        await expect(shell.locator('.lab-session-family-pane').nth(1).getByTestId('prompt-input')).toBeEnabled();
        expect((await workspace.inspect()).views.filter(view => view.attachedTo === sourceId)).toHaveLength(1);
        expect(creations).toEqual([]);
        await expect(page.getByText('The selected session view no longer matches this session.', { exact: true })).toHaveCount(0);
        expect(workspace.errors).toEqual([]);
      } catch (error) {
        await test.info().attach('saved-side-navigation-state', { body: JSON.stringify({ phase, window: await workspace.inspect(), errors: workspace.errors,
          visibleText: await page.locator('body').innerText() }, null, 2), contentType: 'application/json' });
        throw error;
      } finally { await workspace.close(); }
    });
  }
}

test('a dock Side opens beside its source when the same native session is already open in the primary', async ({ page, context }) => {
  const workspace = await createWorkspace(page, context);
  let phase = 'prepare';
  try {
    const dock = await workspace.createNative('Dock source');
    await workspace.apply([
      createWindowView('main', { ...workspace.binding, title: 'Primary source' }, 'primary'),
      createWindowView('dock', dock),
    ], 'main', 'dock');
    const source = page.locator('.lab-bindable-session-window[data-view-id="dock"]').locator('.lab-session-family-pane').first();
    phase = 'create the dock side';
    await expect(source.getByTestId('prompt-input')).toBeEnabled();
    await source.getByTestId('prompt-input').fill('/side Inspect the session already shown elsewhere');
    await expect(source.getByTestId('prompt-submit')).toBeEnabled();
    await source.getByTestId('prompt-submit').click();
    await expect.poll(async () => (await workspace.inspect()).views.some(view => view.attachedTo === 'dock')).toBe(true);
    const side = (await workspace.inspect()).views.find(view => view.attachedTo === 'dock')!;
    expect(side.binding).toBeTruthy();
    await closeListedView(page, side.id);
    await closeWindows(page);
    phase = 'open the side native session in the independent primary';
    await workspace.apply([
      createWindowView('main', { ...side.binding!, title: 'Side also open as primary' }, 'primary'),
      createWindowView('dock', dock),
    ], 'main', 'dock');
    const primary = page.locator('[data-primary-group-id="main"]');
    await expect(primary.locator('.agent-message-user').last()).toContainText('Inspect the session already shown elsewhere');
    await expect(primary.getByTestId('prompt-input')).toBeEnabled();
    phase = 'open the dock footer while its target is the current primary native';
    await source.getByRole('navigation', { name: 'Forked sessions', exact: true }).getByRole('button', { name: /^Side 1 ·/ }).click();
    await expect.poll(async () => (await workspace.inspect()).views.find(view => view.attachedTo === 'dock')?.binding?.nativeSessionId).toBe(side.binding!.nativeSessionId);
    expect((await workspace.inspect()).views.find(view => view.id === 'main')!.binding?.nativeSessionId).toBe(side.binding!.nativeSessionId);
    await expect(page.locator('.lab-bindable-session-window[data-view-id="dock"]').locator('.lab-session-family-pane').nth(1).getByTestId('prompt-input')).toBeEnabled();
    expect(workspace.errors).toEqual([]);
  } catch (error) {
    await test.info().attach('window-side-state', { body: JSON.stringify({ phase, window: await workspace.inspect(), errors: workspace.errors }, null, 2), contentType: 'application/json' });
    throw error;
  } finally { await workspace.close(); }
});
