import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { joinedFixture } from './session-succession-joined-fixture.js';
import { activateComposerAction } from './composer-actions.js';

test.use({ actionTimeout: 10000 });

async function moveTracking(page: Page) {
  const tracking = page.getByRole('button', { name: 'Tracked sessions', exact: true });
  if (!await tracking.isVisible()) return;
  const box = await tracking.boundingBox();
  if (!box) throw new Error('Tracking trigger unavailable');
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    const touch = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - 80, y: point.y + 80 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
  } else {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x - 80 + box.width / 2, box.y + 80 + box.height / 2, { steps: 5 }); await page.mouse.up();
  }
}

async function waitForPrimaryView(page: Page) {
  await expect(page.locator('.lab-has-agent')).toBeVisible();
  const close = page.getByRole('button', { name: 'Close Context', exact: true });
  if (await close.isVisible()) await close.click();
  const path = page.getByRole('combobox', { name: 'Side path' });
  if (await path.isVisible()) await path.selectOption({ index: 0 });
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeVisible();
}

async function openHandoff(page: Page) {
  await waitForPrimaryView(page);
  await moveTracking(page);
  const primary = page.locator('.lab-primary-conversation'), input = primary.getByTestId('prompt-input');
  const draft = await input.textContent();
  const images = await primary.locator('[data-image-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-image-id')));
  if (draft || images.length) {
    await activateComposerAction(primary, 'Open chat commands');
    await primary.getByRole('option', { name: /^\/handoff/ }).click();
    await expect(input).toHaveText(draft ?? '');
    expect(await primary.locator('[data-image-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-image-id')))).toEqual(images);
  } else {
    await input.fill('/handoff');
    await input.press('Enter');
    await expect(input).toHaveText('');
  }
  const dialog = page.getByRole('dialog', { name: 'Hand off conversation' });
  await expect(dialog.getByRole('button', { name: 'Hand off', exact: true })).toBeEnabled();
  return dialog;
}
async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}
async function currentNative(page: Page, scope: string) {
  return page.evaluate(scope => {
    const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
    const slot = document.slots.find((slot: { id: string }) => slot.id === document.primary);
    return slot.intent.target.native.nativeSessionId;
  }, scope);
}
async function openPrimary(page: Page, f: Awaited<ReturnType<typeof joinedFixture>>) {
  await page.goto(`${f.origin}/?host=${f.hostId}&provider=fixture&session=A`);
  await waitForPrimaryView(page);
}
async function send(page: Page, text: string) {
  const path = page.getByRole('combobox', { name: 'Side path' });
  if (await path.isVisible()) await path.selectOption({ index: 0 });
  await page.locator('.lab-primary-conversation').getByTestId('prompt-input').fill(text);
  await page.locator('.lab-primary-conversation').getByTestId('prompt-input').press('Enter');
}
async function storedImage(page: Page, key: string, imageId: string) {
  return page.evaluate(async ({ key, imageId }) => {
    type Draft = { scope: string; parts: Array<{ type: string; imageId?: string }>; images: Record<string, unknown> };
    type Image = { blob?: Blob; blobBytes?: ArrayBuffer };
    const stored = await new Promise<{ draft?: Draft; image?: Image }>((resolve, reject) => {
      const opened = indexedDB.open('agent-remote-image-drafts', 2);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const database = opened.result, tx = database.transaction(['drafts', 'images'], 'readonly');
        const draft = tx.objectStore('drafts').get(key), image = tx.objectStore('images').get(JSON.stringify([key, imageId]));
        tx.oncomplete = () => { database.close(); resolve({ draft: draft.result, image: image.result }); };
        tx.onabort = () => { database.close(); reject(tx.error); };
      };
    });
    const bytes = stored.image?.blobBytes ?? await stored.image?.blob?.arrayBuffer();
    return { scope: stored.draft?.scope, partImageIds: stored.draft?.parts.filter(part => part.type === 'image').map(part => part.imageId),
      imageIds: Object.keys(stored.draft?.images ?? {}), bytes: bytes ? Array.from(new Uint8Array(bytes)) : [] };
  }, { key, imageId });
}

test('real joined UI hands A to B, sends deferred context once, reloads and hands B to C', async ({ page, context, browser }) => {
  test.setTimeout(90000);
  const f = await joinedFixture(), second = await browser.newContext();
  let release = () => {};
  try {
    await f.seed(context); await f.seed(second);
    const favoriteResponse = await context.request.get(`${f.scope}v1/favorites`);
    const favorites = await favoriteResponse.json();
    const saved = await context.request.post(`${f.scope}v1/favorites`, { headers: { origin: f.origin }, data: {
      revision: favorites.revision, type: 'save-session', folderId: null,
      session: { hostId: f.hostId, providerId: 'fixture', nativeSessionId: 'A', title: 'Joined primary A' },
    } });
    expect(saved.ok()).toBe(true);
    await openPrimary(page, f);
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for Joined primary A', exact: true }).click();
    await page.getByRole('button', { name: 'Track', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Joined primary A', exact: true }).locator('.lab-session-row').click();
    await moveTracking(page);
    await send(page, '/side Joined Side requirement');
    await expect.poll(() => f.sessions.get('S')!.sent.length).toBe(1);
    const sidePath = page.getByRole('combobox', { name: 'Side path' });
    if (await sidePath.isVisible()) await sidePath.selectOption({ index: 1 });
    await page.locator('.lab-side-conversation').getByTestId('prompt-input').fill('Joined Side local draft');
    await send(page, '/ask Joined Ask requirement');
    const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask).toBeVisible();
    await ask.getByTestId('prompt-input').fill('Joined Ask draft');
    await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
    const expandActions = page.getByRole('button', { name: 'Expand session actions', exact: true });
    if (await expandActions.isVisible()) await expandActions.click();
    const options = page.locator('.lab-primary-conversation').getByRole('button', { name: 'Session view options', exact: true });
    if (!await options.isVisible()) await page.getByRole('button', { name: 'More session actions', exact: true }).click();
    await options.click();
    await page.locator('input[type="radio"][value="content"]').check();
    await page.locator('.lab-primary-conversation').getByTestId('prompt-input').click();
    const originalOwners = await page.evaluate(scope => {
      const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
      return { owners: document.slots.find((slot: { id: string }) => slot.id === document.primary).owners,
        edges: document.edges, asks: document.asks, tracks: document.tracks };
    }, f.scope);
    await send(page, 'Ordinary settled A input');
    await expect.poll(() => f.sessions.get('A')!.sent).toEqual(['Ordinary settled A input']);
    await page.locator('.lab-primary-conversation').getByTestId('prompt-input').fill('Device one retained draft');
    const other = await second.newPage(); await openPrimary(other, f);
    await other.getByTestId('prompt-input').fill('Device two retained draft');
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.gateCreate(async () => { entered = true; await gate; });
    const dialog = await openHandoff(page);
    await expect(dialog).toContainText(f.root);
    await expect(dialog).toContainText('This step sends no message.');
    await expect(dialog.getByRole('combobox', { name: 'Successor provider' })).toHaveValue('fixture');
    await screenshot(page, 'handoff-chooser');
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    const progress = page.locator('.lab-handoff-notice');
    await expect(dialog).toBeHidden();
    await expect(progress.getByRole('status')).toContainText('Handing off');
    await expect(page.locator('.lab-primary-conversation').getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await screenshot(page, 'handoff-progress');
    const description = await (await f.action(second, 'describe', { providerId: 'fixture', nativeSessionId: 'A' })).json();
    const competing = await f.action(second, 'prepare', { operationId: 'competing-browser', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: description.role.revision });
    expect(competing.status()).toBe(409); expect(f.creates()).toBe(1);
    expect(f.sessions.get('A')!.sent).toEqual(['Ordinary settled A input']);
    release(); f.gateCreate(async () => {});
    await expect(progress).toBeHidden();
    expect(f.sessions.get('B')!.sent).toEqual([]);
    await expect.poll(() => currentNative(page, f.scope)).toBe('B');
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toHaveText('Device one retained draft');
    await expect(page.getByRole('navigation', { name: 'Session handoff history' })).toContainText('Continued from');
    await screenshot(page, 'handoff-current-before-first-input');
    const firstOperation = f.actions.find(item => item.action === 'prepare')!.body.operationId;
    await send(page, 'First explicit B input');
    await expect.poll(() => f.sessions.get('B')!.sent.length).toBe(1);
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toHaveText('');
    await expect(page.locator('.lab-primary-conversation .agent-composer-draft > .agent-composer-note')).toHaveCount(0);
    await expect(page.locator('.lab-primary-conversation .agent-outgoing-message')).toHaveCount(0);
    await screenshot(page, 'handoff-current-after-first-input');
    const input = f.sessions.get('B')!.sent[0]!;
    expect(input).toContain('Original joined requirement'); expect(input).toContain('First explicit B input');
    expect(input).toContain('quoted conversation history');
    const attachment = (await f.contextState()).attachments[0];
    expect(attachment.deliveries).toHaveLength(1);
    expect(attachment.deliveries[0].preparedInput.witness.nativeSessionId).toBe('B');
    await send(page, 'Ordinary settled B input');
    await expect.poll(() => f.sessions.get('B')!.sent.length).toBe(2);
    expect(f.sessions.get('B')!.sent[1]).toBe('Ordinary settled B input');
    await page.locator('.lab-primary-conversation').getByTestId('prompt-input').fill('Device one after reload');
    await expect.poll(() => page.evaluate(scope => Object.values(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`) ?? '{}')), f.scope)).toContain('Device one after reload');
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64');
    const chooser = page.waitForEvent('filechooser');
    await activateComposerAction(page.locator('.lab-primary-conversation'), 'Add images');
    await (await chooser).setFiles({ name: 'retained-joined.png', mimeType: 'image/png', buffer: imageBytes });
    const image = page.locator('.lab-primary-conversation [data-image-id]');
    await expect(image).toHaveCount(1);
    const imageId = (await image.getAttribute('data-image-id'))!;
    const expectedImage = { scope: f.scope, partImageIds: [imageId], imageIds: [imageId], bytes: [...imageBytes] };
    await expect.poll(() => storedImage(page, originalOwners.owners.image.key, imageId)).toEqual(expectedImage);
    await second.setOffline(true);
    await page.reload(); await expect.poll(() => currentNative(page, f.scope)).toBe('B');
    await expect(page.locator(`[data-image-id="${imageId}"]`)).toHaveCount(1);
    expect(await storedImage(page, originalOwners.owners.image.key, imageId)).toEqual(expectedImage);
    const next = await openHandoff(page); await next.getByRole('button', { name: 'Hand off', exact: true }).click();
    await expect(progress).toBeHidden();
    await expect.poll(() => currentNative(page, f.scope)).toBe('C');
    expect(f.creates()).toBe(2); expect(f.sessions.get('C')!.sent).toEqual([]);
    const stale = await f.action(context, 'commit', { operationId: firstOperation });
    expect(stale.ok()).toBe(true);
    await expect.poll(() => currentNative(page, f.scope)).toBe('C');
    expect((await f.state()).roles[0].role.current.nativeSessionId).toBe('C');
    await second.setOffline(false); await other.reload();
    await expect.poll(() => currentNative(other, f.scope)).toBe('C');
    await expect(other.getByTestId('prompt-input')).toHaveText('Device two retained draft');
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toContainText('Device one after reload');
    expect(f.sessions.get('A')!.sent).toEqual(['Ordinary settled A input']);
    const retained = await page.evaluate(scope => {
      const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
      return { owners: document.slots.find((slot: { id: string }) => slot.id === document.primary).owners,
        edges: document.edges, asks: document.asks, tracks: document.tracks,
        auxiliary: document.slots.filter((slot: { intent: { target: { native: { nativeSessionId: string } } } }) => ['S', 'T'].includes(slot.intent.target.native.nativeSessionId)) };
    }, f.scope);
    expect(retained.owners).toEqual(originalOwners.owners);
    const retainedPayloads = await page.evaluate(({ scope, displayKey }) => ({
      drafts: Object.values(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`) ?? '{}')),
      askDrafts: Object.values(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:ask:drafts`) ?? '{}')),
      display: JSON.parse(localStorage.getItem(`agent-remote:recovery:${scope}:view:${displayKey}`) ?? '{}'),
    }), { scope: f.scope, displayKey: retained.owners.display.key });
    expect(retainedPayloads.drafts).toContain('Joined Side local draft');
    expect(retainedPayloads.askDrafts).toContain('Joined Ask draft');
    expect(retainedPayloads.display.mode).toBe('content');
    const secondLayout = await other.evaluate(scope => JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).edges, f.scope);
    expect(secondLayout).toEqual([]);
    await expect(page.locator(`[data-image-id="${imageId}"]`)).toHaveCount(1);
    expect(await storedImage(page, retained.owners.image.key, imageId)).toEqual(expectedImage);
    expect(retained.edges).toEqual(originalOwners.edges);
    expect(retained.asks.map((ask: { id: string }) => ask.id)).toEqual(originalOwners.asks.map((ask: { id: string }) => ask.id));
    expect(retained.tracks.map((track: { entryId: string }) => track.entryId)).toEqual(originalOwners.tracks.map((track: { entryId: string }) => track.entryId));
    expect(retained.auxiliary.map((slot: { intent: { target: { native: { nativeSessionId: string } } } }) => slot.intent.target.native.nativeSessionId).sort()).toEqual(['S', 'T']);
    const late = await f.lateSourceInput(context);
    expect(late.type).toBe('protocol_error');
    expect(f.sessions.get('A')!.sent).toEqual(['Ordinary settled A input']);
    const latestFavorites = await (await context.request.get(`${f.scope}v1/favorites`)).json();
    expect(latestFavorites.stars[0].nativeSessionId).toBe('C');
    await screenshot(page, 'handoff-current-with-retained-image');
    const history = page.getByRole('navigation', { name: 'Session handoff history' });
    await history.getByRole('link').first().click();
    await expect(history.getByRole('link', { name: 'Return to current', exact: true })).toBeVisible();
    await expect(page.locator('.lab-primary-conversation .agent-outgoing-message')).toHaveCount(0);
    await screenshot(page, 'handoff-predecessor-history');
    await history.getByRole('link', { name: 'Return to current', exact: true }).click();
    await expect.poll(() => currentNative(page, f.scope)).toBe('C');
  } finally { release(); await second.close(); await f.close(); }
});

test('page cancellation retains a late empty candidate without activating it', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await joinedFixture(); let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
  try {
    await f.seed(context); await openPrimary(page, f);
    f.gateCreate(async () => { entered = true; await gate; });
    const dialog = await openHandoff(page); await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    const progress = page.locator('.lab-handoff-notice');
    await expect(dialog).toBeHidden();
    await progress.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(progress.getByRole('button', { name: 'Cancel Handoff' })).toBeEnabled();
    await screenshot(page, 'handoff-preparation-details');
    await progress.getByRole('button', { name: 'Cancel Handoff' }).click();
    await expect(progress.getByRole('status')).toContainText('Handoff cancelled');
    release();
    await expect.poll(async () => (await f.state()).roles[0].localPreparations[0].orphanCandidate?.nativeSessionId).toBe('B');
    await expect(progress.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    expect(f.creates()).toBe(1); expect(f.sessions.get('B')!.sent).toEqual([]);
    const state = await f.state();
    expect(state.roles[0].role.current.nativeSessionId).toBe('A');
    expect(state.roles[0].operations[0].phase).toBe('cancelled');
    expect(state.roles[0].localPreparations[0].orphanCandidate.nativeSessionId).toBe('B');
    await screenshot(page, 'handoff-cancelled');
    await progress.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(progress).toBeHidden();
    await expect.poll(() => currentNative(page, f.scope)).toBe('A');
  } finally { release(); await f.close(); }
});

test('manual cancellation settles a Gateway refusal before preparation enrollment and restores A', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await joinedFixture({ rejectFirstPreparation: true });
  try {
    await f.seed(context); await openPrimary(page, f);
    const primary = page.locator('.lab-primary-conversation'), input = primary.getByTestId('prompt-input');
    await input.fill('Retained manual recovery draft');
    const dialog = await openHandoff(page);
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
    const progress = page.locator('.lab-handoff-notice');
    await expect(dialog).toBeHidden();
    await expect(progress.getByRole('status')).toContainText('not yet confirmed');
    await expect(primary.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    const prepared = f.actions.find(item => item.action === 'prepare')!;
    expect(prepared.result).toMatchObject({ code: 'succession_projection_capacity_exceeded' });
    expect(f.gatewayState().tenants[0]!.broker.associations?.freezes ?? []).toEqual([]);
    expect(f.enrollmentActions.filter(item => item.action === 'prepare')).toHaveLength(0);
    expect(f.creates()).toBe(0); expect(f.sessions.has('B')).toBe(false);
    await progress.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(progress.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
    await expect(progress.getByRole('button', { name: 'Cancel Handoff', exact: true })).toBeEnabled();
    await screenshot(page, 'handoff-manual-fallback-before-cancel');
    await progress.getByRole('button', { name: 'Cancel Handoff', exact: true }).click();
    await expect(progress.getByRole('status')).toContainText('Handoff cancelled');
    await expect(progress.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    await expect.poll(() => currentNative(page, f.scope)).toBe('A');
    await expect(input).toHaveText('Retained manual recovery draft');
    await expect(primary.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    const cancelled = f.actions.filter(item => item.action === 'cancel');
    expect(cancelled).toHaveLength(1); expect(cancelled[0]!.body).toEqual(prepared.body);
    expect(cancelled[0]!.result).toMatchObject({ record: { operationId: prepared.body.operationId, phase: 'cancelled' } });
    const state = await f.state();
    expect(state.roles[0].role.current.nativeSessionId).toBe('A');
    expect(state.roles[0].role.revision).toBe(1);
    expect(state.roles[0].operations).toEqual([expect.objectContaining({ operationId: prepared.body.operationId, phase: 'cancelled' })]);
    expect(f.creates()).toBe(0); expect(f.sessions.has('B')).toBe(false);
    const evidencePath = test.info().outputPath('handoff-manual-fallback.json');
    await writeFile(evidencePath, JSON.stringify({ gatewayActions: f.actions, hostActions: f.enrollmentActions, state }, null, 2));
    await test.info().attach('handoff-manual-fallback.json', { contentType: 'application/json', path: evidencePath });
    await screenshot(page, 'handoff-manual-fallback-restored');
    await progress.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(progress).toBeHidden();
    await send(page, 'A input after manual recovery');
    await expect.poll(() => f.sessions.get('A')!.sent).toEqual(['A input after manual recovery']);
    await expect(input).toHaveText('');
    await expect(primary.locator('.agent-outgoing-message')).toHaveCount(0);
  } finally { await f.close(); }
});

test('lost commit response recovers the same B and operation after owned Host and Gateway restart', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await joinedFixture({ omitDispatchAcceptance: true });
  const browserActions: string[] = [];
  page.on('request', request => {
    const action = /\/succession\/(\w+)$/.exec(new URL(request.url()).pathname)?.[1];
    if (action) browserActions.push(action);
  });
  try {
    await f.seed(context); await openPrimary(page, f);
    let recoveryAvailable = false;
    await page.route('**/succession/status', route => recoveryAvailable ? route.continue() : route.abort('failed'));
    const dialog = await openHandoff(page); f.dropCommitResponse();
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
    const progress = page.locator('.lab-handoff-notice');
    await expect(dialog).toBeHidden();
    await expect(progress.getByRole('status')).toContainText('not yet confirmed');
    await progress.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(progress.getByRole('alert')).toBeVisible();
    await screenshot(page, 'handoff-uncertain-details');
    const operationId = f.actions.find(item => item.action === 'prepare')!.body.operationId;
    expect((await f.state()).roles[0].role.current.nativeSessionId).toBe('B');
    expect(f.creates()).toBe(1); expect(f.sessions.get('B')!.sent).toEqual([]);
    await f.restart();
    recoveryAvailable = true;
    await page.reload();
    await waitForPrimaryView(page);
    try { await expect(progress).toBeHidden(); }
    catch (error) {
      await progress.getByRole('button', { name: 'Details', exact: true }).click();
      await screenshot(page, 'handoff-recovery-refresh-failed');
      throw error;
    }
    await expect.poll(() => currentNative(page, f.scope)).toBe('B');
    const recoveryState = await f.state();
    const recoveryEvidencePath = test.info().outputPath('handoff-recovery-transport.json');
    await writeFile(recoveryEvidencePath, JSON.stringify({
      browserActions, gatewayActions: f.actions.map(({ action, body }) => ({ action, body })), hostActions: f.enrollmentActions,
      role: recoveryState.roles[0].role, operations: recoveryState.roles[0].operations,
    }, null, 2));
    await test.info().attach('handoff-recovery-transport.json', { contentType: 'application/json', path: recoveryEvidencePath });
    expect(f.actions.filter(item => ['prepare', 'commit', 'status'].includes(item.action)).every(item => item.body.operationId === operationId)).toBe(true);
    expect(f.actions.filter(item => item.action === 'prepare')).toHaveLength(1);
    // Empty HTTP responses can be retried below fetch; count UI requests and Host mutations separately.
    expect(browserActions.filter(action => action === 'commit')).toHaveLength(1);
    expect(f.enrollmentActions.filter(item => item.action === 'commit')).toEqual([{ action: 'commit', operationId }]);
    expect(recoveryState.roles[0].role.revision).toBe(2);
    expect(recoveryState.roles[0].operations.map(({ operationId, phase, committedRevision }: { operationId: string; phase: string; committedRevision?: number }) => ({ operationId, phase, committedRevision })))
      .toEqual([{ operationId, phase: 'committed', committedRevision: 2 }]);
    expect(f.creates()).toBe(1); expect(f.sessions.get('B')!.sent).toEqual([]);
    await screenshot(page, 'handoff-recovered-current');
    await send(page, 'Recovered B first input'); await expect.poll(() => f.sessions.get('B')!.sent.length).toBe(1);
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toHaveText('');
    await expect(page.locator('.lab-primary-conversation .agent-composer-draft > .agent-composer-note')).toHaveCount(0);
    await expect(page.locator('.lab-primary-conversation .agent-outgoing-message')).toHaveCount(0);
    await screenshot(page, 'handoff-recovered-first-input');
    expect(f.sessions.get('B')!.sent[0]).toContain('Original joined requirement');
    expect(f.sessions.get('A')!.sent).toEqual([]);
  } finally { await f.close(); }
});
