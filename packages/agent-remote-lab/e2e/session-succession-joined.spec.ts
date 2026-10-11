import { expect, test, type Page } from '@playwright/test';
import { joinedFixture } from './session-succession-joined-fixture.js';

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
  const expand = page.getByRole('button', { name: 'Expand session actions', exact: true });
  if (await expand.isVisible()) await expand.click();
  const handoff = page.getByRole('button', { name: 'Handoff', exact: true });
  if (!await handoff.isVisible()) await page.getByRole('button', { name: 'More session actions', exact: true }).click();
  await handoff.click();
  const dialog = page.getByRole('dialog', { name: 'Handoff session' });
  await expect(dialog.getByRole('button', { name: 'Prepare and hand off' })).toBeEnabled();
  return dialog;
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
    await expect(dialog).toContainText('Preparation and commit send no model input');
    await dialog.getByRole('button', { name: 'Prepare and hand off' }).click();
    await expect.poll(() => entered).toBe(true);
    const description = await (await f.action(second, 'describe', { providerId: 'fixture', nativeSessionId: 'A' })).json();
    const competing = await f.action(second, 'prepare', { operationId: 'competing-browser', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: description.role.revision });
    expect(competing.status()).toBe(409); expect(f.creates()).toBe(1);
    expect(f.sessions.get('A')!.sent).toEqual(['Ordinary settled A input']);
    release(); f.gateCreate(async () => {});
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    expect(f.sessions.get('B')!.sent).toEqual([]);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(() => currentNative(page, f.scope)).toBe('B');
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toHaveText('Device one retained draft');
    const firstOperation = f.actions.find(item => item.action === 'prepare')!.body.operationId;
    await send(page, 'First explicit B input');
    await expect.poll(() => f.sessions.get('B')!.sent.length).toBe(1);
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
    await page.locator('.lab-primary-conversation').getByRole('button', { name: 'Add images', exact: true }).click();
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
    const next = await openHandoff(page); await next.getByRole('button', { name: 'Prepare and hand off' }).click();
    await expect(next.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    expect(f.creates()).toBe(2); expect(f.sessions.get('C')!.sent).toEqual([]);
    await next.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(() => currentNative(page, f.scope)).toBe('C');
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
  } finally { release(); await second.close(); await f.close(); }
});

test('page cancellation retains a late empty candidate without activating it', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await joinedFixture(); let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
  try {
    await f.seed(context); await openPrimary(page, f);
    f.gateCreate(async () => { entered = true; await gate; });
    const dialog = await openHandoff(page); await dialog.getByRole('button', { name: 'Prepare and hand off' }).click();
    await expect.poll(() => entered).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel Handoff' }).click();
    await expect(dialog).toContainText('retained for inspection');
    release();
    await expect.poll(() => f.sessions.has('B')).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    expect(f.creates()).toBe(1); expect(f.sessions.get('B')!.sent).toEqual([]);
    const state = await f.state();
    expect(state.roles[0].role.current.nativeSessionId).toBe('A');
    expect(state.roles[0].operations[0].phase).toBe('cancelled');
    expect(state.roles[0].localPreparations[0].orphanCandidate.nativeSessionId).toBe('B');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(() => currentNative(page, f.scope)).toBe('A');
  } finally { release(); await f.close(); }
});

test('lost commit response recovers the same B and operation after owned Host and Gateway restart', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await joinedFixture();
  try {
    await f.seed(context); await openPrimary(page, f);
    const dialog = await openHandoff(page); f.dropCommitResponse();
    await dialog.getByRole('button', { name: 'Prepare and hand off' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    const operationId = f.actions.find(item => item.action === 'prepare')!.body.operationId;
    expect((await f.state()).roles[0].role.current.nativeSessionId).toBe('B');
    expect(f.creates()).toBe(1); expect(f.sessions.get('B')!.sent).toEqual([]);
    await f.restart();
    await dialog.getByRole('button', { name: 'Check status', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(() => currentNative(page, f.scope)).toBe('B');
    expect(f.actions.filter(item => ['prepare', 'commit', 'status'].includes(item.action)).every(item => item.body.operationId === operationId)).toBe(true);
    expect(f.creates()).toBe(1); expect(f.sessions.get('B')!.sent).toEqual([]);
    await send(page, 'Recovered B first input'); await expect.poll(() => f.sessions.get('B')!.sent.length).toBe(1);
    expect(f.sessions.get('B')!.sent[0]).toContain('Original joined requirement');
    expect(f.sessions.get('A')!.sent).toEqual([]);
  } finally { await f.close(); }
});
