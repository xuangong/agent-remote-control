import { randomUUID } from 'node:crypto';
import { selectConnectedHost } from './all-sessions';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createWindowView, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';
import { revealComposerAction } from './composer-actions';

test.setTimeout(90_000);

async function openWindows(page: Page) {
  // Wide pages with a visible sidebar list Windows there; otherwise the floating Window capsule opens its panel.
  const sidebar = page.locator('#lab-context .lab-window-workspaces');
  if ((page.viewportSize()?.width ?? 1280) > 1180 && await sidebar.isVisible()) return sidebar;
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

async function createWorkspace(page: Page, context: BrowserContext) {
  const fixture = await sessionLinkFixture({ automaticSignIn: true, listCreatedSessions: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await selectConnectedHost(page, fixture.hostId);
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

for (const placement of ['primary', 'dock', 'float'] as const) {
  test(`${placement} mobile Side retains its session when reopening composer controls after Close`, async ({ page, context, isMobile }) => {
    test.skip(!isMobile);
    // Exercise the resource chooser UI; the recorded provider does not upload resources.
    await page.routeWebSocket(/session-channel/, route => {
      const server = route.connectToServer();
      server.onMessage(message => {
        const envelope = JSON.parse(String(message));
        const frame = envelope.type === 'message' ? envelope.message : envelope;
        if (frame.type === 'agent_snapshot') frame.payload.capabilities.resourceInput = { maxResources: 8, maxResourceBytes: 52428800, maxMessageBytes: 104857600 };
        route.send(JSON.stringify(envelope));
      });
    });
    const workspace = await createWorkspace(page, context);
    try {
      const sourceId = 'source';
      await workspace.apply([
        ...(placement !== 'primary' ? [createWindowView('main', undefined, 'primary')] : []),
        createWindowView(sourceId, workspace.binding, placement),
      ], placement === 'primary' ? sourceId : 'main', sourceId);
      const shell = page.locator(placement === 'primary' ? '[data-primary-group-id="source"]' : '.lab-bindable-session-window[data-view-id="source"]');
      const source = shell.locator('.lab-session-family-pane').first();
      await expect(source.getByTestId('prompt-input')).toBeEnabled();
      await source.getByTestId('prompt-input').fill('/side Composer focus regression');
      await source.getByTestId('prompt-input').press('Enter');
      await expect.poll(async () => (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)?.id).toBeTruthy();
      const sideId = (await workspace.inspect()).views.find(view => view.attachedTo === sourceId)!.id;
      await (await openWindows(page)).locator(`[data-window-view-id="${sourceId}"]`).click();
      await closeWindows(page);
      await source.getByRole('button', { name: /^Side 1 ·/ }).tap();
      const side = shell.locator('.lab-session-family-pane').nth(1);
      await expect(side.getByTestId('prompt-input')).toBeEnabled();
      const title = await page.title();
      const model = side.getByRole('button', { name: 'Model', exact: true });
      await model.tap();
      await side.getByRole('button', { name: 'Close session controls', exact: true }).tap();
      await expect(model).toBeFocused();
      await model.tap();
      await expect(side).toBeVisible();
      await expect(side.getByRole('region', { name: 'Model settings', exact: true })).toBeVisible();
      await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe(sideId);
      await expect(page).toHaveTitle(title);
      for (const name of ['Add images', 'Add resources']) {
        await side.getByRole('button', { name: 'Close session controls', exact: true }).tap();
        await expect(model).toBeFocused();
        const { action } = await revealComposerAction(side, name);
        const chooser = page.waitForEvent('filechooser');
        await action.tap();
        await (await chooser).setFiles([]);
        await expect(side).toBeVisible();
        await expect.poll(async () => (await workspace.inspect()).selectedViewId).toBe(sideId);
        await expect(page).toHaveTitle(title);
        await model.tap();
        await expect(side.getByRole('region', { name: 'Model settings', exact: true })).toBeVisible();
      }
      expect(workspace.errors).toEqual([]);
    } finally { await workspace.close(); }
  });
}

test('a Side removes its source reference, tells its agent with the next message, and references a session again with /ref', async ({ page, context, isMobile }) => {
  const workspace = await createWorkspace(page, context);
  try {
    const source = page.locator('.lab-session-family-pane').first();
    await expect(source.getByTestId('prompt-input')).toBeEnabled();
    await source.getByTestId('prompt-input').fill('/side Weigh the references');
    await source.getByTestId('prompt-submit').click();
    await expect.poll(async () => (await workspace.inspect()).views.some(view => view.attachedTo)).toBe(true);
    const sideId = (await workspace.inspect()).views.find(view => view.attachedTo)!.id;
    const side = page.locator(`.lab-session-family-pane[data-view-id="${sideId}"]`);
    const references = side.locator('.lab-session-refs');
    await expect(references.locator('.lab-session-ref[data-origin="source"]')).toHaveCount(1);
    await references.getByRole('button', { name: 'Remove reference to New session' }).click();
    await expect(references).toHaveCount(0);
    await expect(page.getByText('Reference removed', { exact: true })).toBeVisible();
    await expect.poll(async () => (await workspace.inspect()).views.find(view => view.id === sideId)?.attachedTo).toBeUndefined();
    const input = side.getByTestId('prompt-input');
    await input.fill('Continue without the source');
    await side.getByTestId('prompt-submit').click();
    const sent = side.locator('.agent-message-user').last();
    await expect(sent.locator('.agent-markdown')).toHaveText('Continue without the source');
    await expect(sent.getByLabel('Session references', { exact: true })).toHaveText('ReferencesNone');
    await input.fill('/ref');
    await side.getByTestId('prompt-submit').click();
    const picker = side.getByRole('dialog', { name: 'Reference a session' });
    await expect(picker.getByRole('button', { name: /^New session/ }).first()).toBeVisible();
    // A touch keyboard leaves little room above the composer; the open picker fits again.
    const viewport = page.viewportSize()!;
    if (isMobile) await page.setViewportSize({ width: viewport.width, height: 460 });
    // The picker stays inside the session, above its row, with the title, filter and Cancel in view and the sessions scrolling.
    const top = async () => (await picker.boundingBox())!.y - (await side.locator('.lab-workbench-layout').first().boundingBox())!.y;
    await expect.poll(top).toBeGreaterThanOrEqual(0);
    const box = (await picker.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((await references.boundingBox())!.y);
    for (const control of [picker.getByText('Reference a session', { exact: true }), picker.getByRole('searchbox'), picker.getByRole('button', { name: 'Cancel', exact: true })]) await expect(control).toBeInViewport({ ratio: 1 });
    expect(await picker.locator('ul').evaluate(list => { list.scrollTop = list.scrollHeight; return list.scrollTop === list.scrollHeight - list.clientHeight; })).toBe(true);
    await page.screenshot({ path: test.info().outputPath('reference-picker.png') });
    // Touching the composer gives up the choice.
    await input.click();
    await expect(picker).toHaveCount(0);
    await page.setViewportSize(viewport);
    await input.fill('/ref');
    await side.getByTestId('prompt-submit').click();
    await picker.getByRole('button', { name: /^New session/ }).first().click();
    await expect(picker).toHaveCount(0);
    await expect(references.locator('.lab-session-ref')).toHaveCount(1);
    await input.fill('Use it again');
    await side.getByTestId('prompt-submit').click();
    await expect(side.locator('.agent-message-user').last().getByLabel('Session references', { exact: true })).toHaveText('ReferencesNew session');
    expect(workspace.errors).toEqual([]);
  } finally { await workspace.close(); }
});

