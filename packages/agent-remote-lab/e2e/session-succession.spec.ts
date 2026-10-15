import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHostedRelay, emptyRelayState, gatewayCookieName, validateRelayState, stageRelayState, type HostedRelayState } from '@orchardworks/agent-remote-hosted';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { PROTOCOL_VERSION, type CommittedSuccessionProjection, type SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
import { createRecordedLabProvider } from '../src/server/recorded.js';
import { createGatewayStaticPages } from '../src/server/gateway-static.js';
import { relaySocket, webRequest, writeResponse } from '../src/server/remote-host-broker.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const native = (nativeSessionId: string) => ({ controllerId: 'browser-installation', providerId: 'recorded', nativeSessionId });

/** Fixture-owned Gateway, authority, uplink and recorded native sessions. */
async function fixture() {
  let denied = false;
  const authority = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body), subject = input.subject ?? input.continuation;
    response.writeHead(denied ? 403 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ active: true, subject, authenticatedAt: Date.now(), validUntil: Date.now() + 60000, expiresAt: Date.now() + 600000 }));
  });
  await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const issuer = `http://127.0.0.1:${(authority.address() as { port: number }).port}`;
  const auth = { origin, issuer, secret: 'browser-succession-fixture-secret-0123456789' };
  const namespace = hash(JSON.stringify([issuer, 'owner']));
  const scope = `${origin}/u/${namespace}/`, credential = 'arc_' + 's'.repeat(43);
  const workspace = { controllerId: 'browser-installation', canonicalCwd: '/fixture' };
  const request = { operationId: 'browser-operation-2', roleId: 'primary', expectedRevision: 1, from: native('A') };
  const projection: CommittedSuccessionProjection = { version: 1, role: { id: 'primary', revision: 2, origin: native('A'), current: native('B'), workspace },
    receipt: { ...request, to: native('B'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: native('B'), workspace, associationRevision: 0, participants: [], capture: { epoch: 'epoch-A', seq: 0, capturedAt: 'now' } } } };
  const receipt: SuccessionAssociationFreeze = { version: 1, token: 'browser-freeze', authority: { version: 1, origin, issuer, namespace, ownerSubject: 'owner' },
    controllerId: 'browser-installation', request, associationRevision: 0, lineage: [native('A')], relations: [] };
  const legacy = { ...emptyRelayState(auth), version: 9 };
  legacy.sessions.push({ hash: hash('owner'), sessionExpiresAt: Date.now() + 600000,
    grant: { authenticatedAt: Date.now(), subject: 'owner', namespace, expiresAt: Date.now() + 60000, ticket: '', nonce: 'nonce', continuation: 'owner', sessionExpiresAt: Date.now() + 600000 } });
  const raw = { ...legacy, tenants: [{ subject: 'owner', namespace, broker: { keys: [[hash(credential), { expires: Date.now() + 600000, installationId: 'browser-installation', kind: 'device' }]],
    hosts: [{ id: 'browser-host', installationId: 'browser-installation', name: 'Succession fixture', legacyDsh: false, providers: [{ providerId: 'recorded', displayName: 'Recorded fixture' }] }],
    bindings: [], creations: [], associations: { version: 5, revision: 1, admissions: [], relationChanges: [], relationResets: [], freezes: [{ hostId: 'browser-host', receipt, released: 'committed', projection }] } } }] };
  const initial = validateRelayState(raw, auth);
  expect(initial.version).toBe(9);
  stageRelayState(initial, initial.version, false);
  expect(initial.version).toBe(11);
  expect(initial.tenants[0]!.broker.associations?.version).toBe(6);
  let saved: HostedRelayState = initial;
  const gateway = createHostedRelay({ ...auth, storage: { initial, async commit(value) { saved = value; } }, scheduler: { schedule() {}, cancel() {} } });
  const serve = await createGatewayStaticPages(resolve('dist'), { origin });
  const reads: string[] = [];
  server.on('request', (incoming, outgoing) => { void (async () => {
    reads.push(incoming.url!);
    const result = await gateway.fetch(webRequest(incoming, new URL(incoming.url!, origin)));
    if (result) return writeResponse(outgoing, result);
    if (await serve(incoming, outgoing)) return;
    outgoing.writeHead(404); outgoing.end();
  })().catch(error => { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(String(error)); }); });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (incoming, socket, head) => { void (async () => {
    const prepared = await gateway.prepareUpgrade(webRequest(incoming, new URL(incoming.url!, origin), false));
    if (!prepared || prepared instanceof Response) { socket.end(`HTTP/1.1 ${prepared?.status ?? 404} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    sockets.handleUpgrade(incoming, socket, head, client => prepared.accept(relaySocket(client)));
  })(); });
  const relay = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  const nativeIds = ['A', 'B', 'S', 'U', 'T', 'D'];
  for (const id of nativeIds) await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: {
    requestId: randomUUID(), operationId: randomUUID(), agentId: `agent-${id}`, providerId: 'recorded', config: { sessionId: id },
  } });
  let successorAvailable = false;
  const controls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const uplink = createRemoteHostUplinkClient({ relay, url: origin.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: credential,
    installationId: 'browser-installation', name: 'Succession fixture', providers: [{ providerId: 'recorded', displayName: 'Recorded fixture' }],
    resolveSession: id => nativeIds.some(nativeId => id === `agent-${nativeId}`) ? relay.requireAgent(id) : undefined,
    async control(control) {
      const body = JSON.parse(control.body ?? '{}'); controls.push({ path: control.path, body });
      if (control.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: [], hasMore: false, revision: '1' }) };
      if (control.path.startsWith('/remote/workspaces')) return { status: 200, body: JSON.stringify({ workspaces: [] }) };
      if (control.path === '/remote/attach') {
        if (body.nativeSessionId === 'B' && !successorAvailable) return { status: 503, body: JSON.stringify({ code: 'host_offline', error: 'Fixture successor unavailable.' }) };
        if (nativeIds.includes(body.nativeSessionId)) return { status: 200, body: JSON.stringify({ agentId: `agent-${body.nativeSessionId}`, nativeSessionId: body.nativeSessionId }) };
      }
      return { status: 404, body: '{}' };
    },
  });
  await uplink.ready;
  return { origin, scope, reads, controls, saved: () => saved, available() { successorAvailable = true; }, deny() { denied = true; },
    async seed(context: BrowserContext, draft: string, layout?: 'side' | 'nested-ask' | 'duplicate') {
      await context.addCookies([{ name: gatewayCookieName(origin, 'session'), value: 'owner', url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const sideAgentIds: Record<string, string> = {};
      for (const nativeSessionId of layout === 'nested-ask' ? ['S', 'U'] : layout === 'side' ? ['S'] : layout === 'duplicate' ? ['B'] : []) {
        const response = await context.request.post(`${scope}v1/remote/hosts/browser-host/attach`, { headers: { origin }, data: { providerId: 'recorded', nativeSessionId } });
        expect(response.ok()).toBe(true); sideAgentIds[nativeSessionId] = (await response.json()).agentId;
      }
      await context.addInitScript(({ scope, draft, layout, sideAgentIds }) => {
        if (sessionStorage.getItem('succession-fixture-seeded')) return;
        sessionStorage.setItem('succession-fixture-seeded', 'true');
        const source = { hostId: 'browser-host', providerId: 'recorded', nativeSessionId: 'A', agentId: 'agent-A', title: 'Original primary' };
        const side = layout === 'duplicate' ? { ...source, nativeSessionId: 'B', agentId: sideAgentIds.B!, title: 'Independent B' }
          : { ...source, nativeSessionId: 'S', agentId: sideAgentIds.S ?? 'agent-S', title: 'Independent Side' };
        const nested = { ...side, nativeSessionId: 'U', agentId: sideAgentIds.U ?? 'agent-U', title: 'Nested Side' };
        const target = { ...side, nativeSessionId: 'T', agentId: 'agent-T', title: 'Independent Ask target' };
        const key = (session: typeof source) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);
        const path = layout === 'nested-ask' ? [source, side, nested] : layout === 'side' || layout === 'duplicate' ? [source, side] : [source];
        localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify(path));
        sessionStorage.setItem(`agent-remote:recovery:${scope}:drafts`, JSON.stringify({ 'agent-A': draft, ...(layout ? { [side.agentId]: 'Side local draft', [nested.agentId]: 'Nested Side draft' } : {}) }));
        if (layout) {
          sessionStorage.setItem(`agent-remote:recovery:${scope}:composition`, JSON.stringify({ path, addressKey: key(source), focus: key(layout === 'nested-ask' ? side : source), anchor: key(layout === 'nested-ask' ? nested : source) }));
          for (let index = 1; index < path.length; index++) {
            const from = path[index - 1]!, to = path[index]!;
            localStorage.setItem(`agent-remote-forks:${scope}:record:side-${index}`, JSON.stringify({ id: `side-${index}`, mode: 'reference', source: from, target: to, configured: true,
              capturedAt: '2026-10-10T00:00:00Z', delivery: 'sent', options: { sourceNativeSessionId: from.nativeSessionId, conversationKind: 'side' }, settings: [] }));
          }
        }
        if (layout === 'nested-ask') {
          sessionStorage.setItem(`agent-remote-forks:ask:${scope}:record:ask-S`, JSON.stringify({ id: 'ask-S', mode: 'reference', source: side, target, configured: true,
            capturedAt: '2026-10-10T00:00:00Z', delivery: 'sent', options: { sourceNativeSessionId: 'S', conversationKind: 'ask' }, settings: [] }));
          sessionStorage.setItem(`agent-remote-ask:${scope}:open-windows`, JSON.stringify([key(side)]));
          localStorage.setItem(`agent-remote-ask:${scope}:enabled:${key(side)}`, 'true');
          sessionStorage.setItem(`agent-remote:recovery:${scope}:ask:drafts`, JSON.stringify({ [key(side)]: 'Independent Ask draft' }));
          const geometry = JSON.stringify([scope, key(side)]);
          localStorage.setItem(`agent-remote-ask:${geometry}:window-position`, JSON.stringify({ x: 18, y: 36 }));
          localStorage.setItem(`agent-remote-ask:${geometry}:window-size`, JSON.stringify({ width: 400, height: 350 }));
        }
        if (layout === 'duplicate') {
          const entries = [source, side];
          localStorage.setItem(`agent-remote-tracking:${scope}`, JSON.stringify(entries.map((entry, index) => ({ ...entry, starredAt: index + 1 }))));
          sessionStorage.setItem(`agent-remote:recovery:${scope}:composition-v2`, JSON.stringify({ version: 2, scope, editRevision: 0, roles: [], retained: [], collapsed: [],
            primary: key(source), address: key(source), focus: key(source), anchor: key(source),
            slots: entries.map(entry => ({ id: key(entry), origin: { kind: 'fixed', target: { hostId: entry.hostId, native: { providerId: entry.providerId, nativeSessionId: entry.nativeSessionId } } }, intent: { kind: 'fixed', target: { hostId: entry.hostId, native: { providerId: entry.providerId, nativeSessionId: entry.nativeSessionId } } },
              metadata: { agentId: entry.agentId, title: entry.title }, owners: { text: { scope, key: entry.agentId }, image: { scope, key: JSON.stringify([scope, key(entry)]) }, display: { scope, key: key(entry) } } })),
            edges: [{ source: key(source), target: key(side), selected: true }],
            tracks: entries.map(entry => ({ entryId: key(entry), slotId: key(entry), view: { primarySlot: key(entry), selections: {}, focus: key(entry), anchor: key(entry) } })), selectedTrack: key(source),
            asks: entries.map((entry, index) => ({ id: `ask:${key(entry)}`, sourceSlot: key(entry), input: { scope, key: `agent-remote-ask:${scope}:inputs:${key(entry)}` },
              geometryScope: JSON.stringify([scope, key(entry)]), text: { scope: `${scope}:ask`, key: key(entry) }, open: false, enabled: true,
              image: { scope, key: JSON.stringify([scope, key({ ...entry, nativeSessionId: index === 0 ? 'T' : 'U' })]) }, display: { scope, key: key({ ...entry, nativeSessionId: index === 0 ? 'T' : 'U' }) },
              records: [{ id: `ask-${entry.nativeSessionId}`, target: key({ ...entry, nativeSessionId: index === 0 ? 'T' : 'U' }) }] })),
          }));
          for (const [index, origin] of entries.entries()) {
            const nativeSessionId = index === 0 ? 'T' : 'U';
            sessionStorage.setItem(`agent-remote-forks:ask:${scope}:record:ask-${origin.nativeSessionId}`, JSON.stringify({ id: `ask-${origin.nativeSessionId}`, mode: 'reference', source: origin,
              target: { ...origin, nativeSessionId, agentId: `agent-${nativeSessionId}` }, configured: true, capturedAt: '2026-10-10T00:00:00Z', delivery: 'sent', options: { sourceNativeSessionId: origin.nativeSessionId }, settings: [] }));
          }
          sessionStorage.setItem(`agent-remote:recovery:${scope}:ask:drafts`, JSON.stringify({ [key(source)]: 'A Ask draft', [key(side)]: 'B Ask draft' }));
        }
      }, { scope, draft, layout, sideAgentIds });
    },
    async close() {
      await uplink.close(); await relay.close(); await gateway.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve())); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); authority.closeAllConnections();
      await new Promise<void>(resolve => authority.close(() => resolve()));
    },
  };
}

function observeInputs(page: Page) {
  const inputs: string[] = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const frame = JSON.parse(String(payload)), message = frame.message ?? frame;
    if (['send_message', 'image_upload_begin', 'execute_command'].includes(message.type)) inputs.push(JSON.stringify(message));
  }));
  return inputs;
}

async function storedImageBytes(page: Page) {
  return page.evaluate(async () => {
    const images = await new Promise<Array<{ imageId: string; blob?: Blob; blobBytes?: ArrayBuffer }>>((resolve, reject) => {
      const opened = indexedDB.open('agent-remote-image-drafts', 2);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const database = opened.result, tx = database.transaction('images', 'readonly'), request = tx.objectStore('images').getAll();
        tx.oncomplete = () => { database.close(); resolve(request.result); };
        tx.onerror = () => { database.close(); reject(tx.error); };
      };
    });
    return Promise.all(images.map(async image => {
      const bytes = image.blobBytes ?? await image.blob!.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { imageId: image.imageId, bytes: Array.from(new Uint8Array(bytes)), sha256: Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('') };
    }));
  });
}

async function openDisplayOptions(page: Page) {
  const expand = page.getByRole('button', { name: 'Expand session actions', exact: true });
  if (await expand.isVisible()) await expand.click();
  const options = page.getByRole('button', { name: 'Session view options', exact: true });
  const more = page.getByRole('button', { name: 'More session actions', exact: true });
  if (!await options.isVisible() && await more.isVisible()) await more.click();
  await options.click();
}

test('a fresh view retains Content, Ask preference and real image bytes after closing its tab', async ({ page, context }, testInfo) => {
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page);
  let current = page;
  try {
    await f.seed(context, 'Legacy A draft');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=D`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.lab-has-agent')).toBeVisible();
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await page.getByTestId('prompt-input').fill('/ask');
    await page.getByTestId('prompt-input').press('Enter');
    await expect(page.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
    await openDisplayOptions(page);
    await page.locator('input[type="radio"][value="content"]').check();
    await page.getByTestId('prompt-input').click();
    const owners = await page.evaluate(scope => {
      const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
      const slot = document.slots.find((slot: { intent: { target: { native: { nativeSessionId: string } } } }) => slot.intent.target.native.nativeSessionId === 'D');
      return { slot, ask: document.asks.find((owner: { sourceSlot: string }) => owner.sourceSlot === slot.id) };
    }, f.scope);
    expect(owners.ask.enabled).toBe(true);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64');
    await page.evaluate(async ({ scope, key, bytes }) => {
      await new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open('agent-remote-image-drafts', 2);
        opened.onerror = () => reject(opened.error);
        opened.onupgradeneeded = () => {
          if (!opened.result.objectStoreNames.contains('drafts')) opened.result.createObjectStore('drafts', { keyPath: 'key' });
          if (!opened.result.objectStoreNames.contains('images')) opened.result.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
        };
        opened.onsuccess = () => {
          const database = opened.result, tx = database.transaction(['drafts', 'images'], 'readwrite');
          tx.oncomplete = () => { database.close(); resolve(); }; tx.onabort = () => { database.close(); reject(tx.error); };
          const imageId = 'fresh-D-image', blobKey = JSON.stringify([key, imageId]);
          tx.objectStore('images').put({ key: blobKey, scope, imageId, blobBytes: Uint8Array.from(bytes).buffer, blobMediaType: 'image/png' });
          tx.objectStore('drafts').put({ version: 1, key, scope, parts: [{ type: 'image', imageId, label: 'Fresh D image' }],
            images: { [imageId]: { imageId, blobKey, uploadId: 'fresh-D-upload', status: 'pending', progress: 0 } }, nextLabel: 2 });
        };
      });
    }, { scope: f.scope, key: owners.slot.owners.image.key, bytes: [...bytes] });
    await page.reload();
    await expect(page.locator('[data-image-id="fresh-D-image"]')).toHaveCount(1);
    const images = await storedImageBytes(page);
    expect(images).toEqual([{ imageId: 'fresh-D-image', bytes: [...bytes], sha256: createHash('sha256').update(bytes).digest('hex') }]);
    await page.close();
    current = await context.newPage();
    const newInputs = observeInputs(current);
    await current.goto(`${f.origin}/?host=browser-host&provider=recorded&session=D`);
    await current.waitForLoadState('networkidle');
    await expect(current.locator('.lab-has-agent')).toBeVisible();
    if (await current.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await current.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(current.locator('[data-image-id="fresh-D-image"]')).toHaveCount(1);
    await expect(current.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
    await expect(current.getByRole('dialog', { name: 'Ask', exact: true })).toHaveCount(0);
    await openDisplayOptions(current);
    await expect(current.locator('input[type="radio"][value="content"]')).toBeChecked();
    const restored = await current.evaluate(scope => {
      const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
      const slot = document.slots.find((slot: { intent: { target: { native: { nativeSessionId: string } } } }) => slot.intent.target.native.nativeSessionId === 'D');
      return { slot, ask: document.asks.find((owner: { sourceSlot: string }) => owner.sourceSlot === slot.id) };
    }, f.scope);
    expect(restored.slot.id).toBe(owners.slot.id); expect(restored.slot.owners).toEqual(owners.slot.owners);
    expect(restored.ask).toMatchObject({ id: owners.ask.id, input: owners.ask.input, text: owners.ask.text, image: owners.ask.image, display: owners.ask.display, enabled: true, open: false });
    expect(await storedImageBytes(current)).toEqual(images);
    expect(inputs).toEqual([]); expect(newInputs).toEqual([]);
    await testInfo.attach('fresh-view-owners.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ owners, restored, images }, null, 2)) });
    await current.screenshot({ path: testInfo.outputPath('fresh-view-new-tab.png'), fullPage: true });
  } finally { if (!current.isClosed()) await current.goto('about:blank'); await f.close(); }
});

test('two tabs retain independent layout, address and focus while sharing durable owners', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Checks a visible desktop Side beside the primary.');
  test.setTimeout(60000);
  const f = await fixture(); f.available();
  let other: Page | undefined;
  try {
    await f.seed(context, 'First tab draft', 'side');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toHaveText('First tab draft');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.locator('.lab-side-conversation')).toHaveCount(1);
    other = await context.newPage();
    await other.goto(`${f.origin}/?host=browser-host&provider=recorded&session=D`);
    await expect(other.locator('.lab-has-agent')).toBeVisible();
    await expect(other.locator('.lab-side-conversation')).toHaveCount(0);
    const layout = (tab: Page) => tab.evaluate(scope => {
      const { primary, address, focus, anchor, edges, selectedTrack } = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!);
      return { primary, address, focus, anchor, edges, selectedTrack };
    }, f.scope);
    await other.getByTestId('prompt-input').click();
    await expect.poll(async () => (await layout(other!)).primary).toContain('D');
    await expect.poll(async () => (await layout(other!)).focus).toContain('D');
    const secondLayout = await layout(other);
    const expandSide = page.getByRole('button', { name: 'Expand window 2: Independent Side', exact: true });
    if (await expandSide.isVisible()) await expandSide.click();
    await page.locator('.lab-side-conversation').getByTestId('prompt-input').click();
    await expect.poll(async () => (await layout(page)).focus).toContain('S');
    expect(await layout(other)).toEqual(secondLayout); await expect(other).toHaveURL(/session=D/);
    const firstLayout = await layout(page), firstUrl = page.url();
    await other.getByTestId('prompt-input').fill('/ask'); await other.getByTestId('prompt-input').press('Enter');
    await expect(other.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
    expect(await layout(page)).toEqual(firstLayout); expect(page.url()).toBe(firstUrl);
    await other.reload(); await expect(other.locator('.lab-has-agent')).toBeVisible();
    expect(await layout(other)).toEqual(secondLayout); await expect(other.locator('.lab-side-conversation')).toHaveCount(0);
    expect(await layout(page)).toEqual(firstLayout);
    await testInfo.attach('two-tab-layouts.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ firstLayout, secondLayout }, null, 2)) });
  } finally { await page.goto('about:blank'); if (other) await other.close(); await f.close(); }
});

test('authorized B failure survives reload with an editable local draft and explicit Retry reaches only B', async ({ page, context }, testInfo) => {
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page);
  try {
    await f.seed(context, 'Device draft before succession');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    await expect(page.getByTestId('prompt-input')).toHaveText('Device draft before succession');
    await page.getByTestId('prompt-input').press('ControlOrMeta+A');
    await page.getByTestId('prompt-input').pressSequentially('Edit while B is offline');
    await expect(page.getByTestId('prompt-input')).toHaveText('Edit while B is offline');
    await expect(page).toHaveURL(/session=B/);
    await expect.poll(() => page.evaluate(scope => Object.values(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`) ?? '{}')), f.scope)).toContain('Edit while B is offline');
    await page.reload();
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    await expect(page.getByTestId('prompt-input')).toHaveText('Edit while B is offline');
    expect(f.controls.filter(item => item.path === '/remote/attach').map(item => item.body.nativeSessionId)).toEqual(['B', 'B']);
    const editor = await page.getByTestId('prompt-input').elementHandle();
    f.available();
    await page.getByRole('button', { name: 'Retry session', exact: true }).click();
    await expect(page.locator('.lab-has-agent')).toBeVisible();
    await expect(page.getByTestId('prompt-input')).toHaveText('Edit while B is offline');
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    expect(await page.getByTestId('prompt-input').evaluate((node, original) => node === original, editor)).toBe(true);
    expect(f.controls.filter(item => item.path === '/remote/attach').map(item => item.body.nativeSessionId)).toEqual(['B', 'B', 'B']);
    expect(f.controls.some(item => /create|settings/.test(item.path))).toBe(false);
    expect(inputs).toEqual([]);
    expect(f.reads.some(path => path.includes('/session-successions/current'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('succession-retry.png'), fullPage: true });
  } catch (error) {
    await testInfo.attach('draft-state.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(await page.evaluate(() => ({ html: document.querySelector('[data-testid="prompt-input"]')?.outerHTML, active: document.activeElement?.outerHTML, storage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])) })), null, 2)) });
    await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }); throw error;
  } finally { await page.goto('about:blank'); await f.close(); }
});

test('separate devices retain distinct drafts and explicit A history owns a separate draft', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Creates two isolated browser contexts.');
  test.setTimeout(60000);
  const f = await fixture(), first = await browser.newContext(), second = await browser.newContext();
  try {
    await f.seed(first, 'First device draft', 'side'); await f.seed(second, 'Second device draft');
    const a = await first.newPage(), b = await second.newPage();
    const attachments: string[][] = [[], []];
    for (const [index, page] of [a, b].entries()) page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/attach')) attachments[index]!.push(request.postDataJSON().nativeSessionId); });
    await Promise.all([a.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`), b.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`)]);
    const firstPrimary = a.locator('.lab-primary-conversation').getByTestId('prompt-input');
    await expect(firstPrimary).toHaveText('First device draft');
    await expect(b.getByTestId('prompt-input')).toHaveText('Second device draft');
    await expect(a).toHaveURL(/session=B/); await expect(b).toHaveURL(/session=B/);
    await expect(a.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    await a.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A&intent=history`);
    await expect(a.locator('.lab-has-agent')).toBeVisible();
    await expect(firstPrimary).toHaveText('');
    await firstPrimary.fill('Concrete A history draft');
    await expect.poll(() => a.evaluate(scope => Object.values(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`) ?? '{}')), f.scope)).toContain('Concrete A history draft');
    await a.reload();
    await expect(firstPrimary).toHaveText('Concrete A history draft');
    await expect(a).toHaveURL(/intent=history/);
    await expect(b.getByTestId('prompt-input')).toHaveText('Second device draft');
    expect(attachments[0]!.filter(id => id !== 'S')).toEqual(['B', 'A', 'A']); expect(attachments[1]).toEqual(['B']);
    await a.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await expect(a.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    f.available();
    await a.getByRole('button', { name: 'Retry session', exact: true }).click();
    await b.getByRole('button', { name: 'Retry session', exact: true }).click();
    await expect(firstPrimary).toHaveText('First device draft'); await expect(b.getByTestId('prompt-input')).toHaveText('Second device draft');
    await expect(a.locator('.lab-side-conversation')).toHaveCount(1); await expect(b.locator('.lab-side-conversation')).toHaveCount(0);
    for (const page of [a, b]) await expect.poll(() => page.evaluate(scope => {
      const document = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`) ?? '{}');
      return document.roles?.map((role: { roleId: string; appliedRevision: number }) => [role.roleId, role.appliedRevision]);
    }, f.scope)).toEqual([['primary', 2]]);
  } finally { await first.close(); await second.close(); await f.close(); }
});


test('opaque image bytes survive failed-primary reload and stay with the same editor on B confirmation', async ({ page, context }, testInfo) => {
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page);
  try {
    await f.seed(context, 'Image owner draft');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add images', exact: true }).click();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64');
    await (await chooser).setFiles({ name: 'retained.png', mimeType: 'image/png', buffer: bytes });
    await expect(page.locator('[data-image-id]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
      const opened = indexedDB.open('agent-remote-image-drafts', 2);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const database = opened.result, tx = database.transaction('images', 'readonly'), request = tx.objectStore('images').getAll();
        tx.oncomplete = () => { database.close(); resolve(request.result.reduce((sum, image) => sum + (image.blobBytes?.byteLength ?? image.blob?.size ?? 0), 0)); };
        tx.onerror = () => { database.close(); reject(tx.error); };
      };
    }))).toBe(bytes.length);
    const imageId = await page.locator('[data-image-id]').getAttribute('data-image-id');
    const originalBytes = await storedImageBytes(page);
    expect(originalBytes).toEqual([{ imageId, bytes: [...bytes], sha256: createHash('sha256').update(bytes).digest('hex') }]);
    await page.reload(); await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.locator('[data-image-id]')).toHaveAttribute('data-image-id', imageId!);
    expect(await storedImageBytes(page)).toEqual(originalBytes);
    await expect(page.getByTestId('prompt-input')).toContainText('Image owner draft');
    const editor = await page.getByTestId('prompt-input').elementHandle();
    f.available(); await page.getByRole('button', { name: 'Retry session', exact: true }).click();
    await expect(page.locator('.lab-has-agent')).toBeVisible();
    expect(await page.getByTestId('prompt-input').evaluate((node, original) => node === original, editor)).toBe(true);
    await expect(page.locator('[data-image-id]')).toHaveAttribute('data-image-id', imageId!);
    expect(await storedImageBytes(page)).toEqual(originalBytes);
    expect(inputs).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('retained-image.png'), fullPage: true });
  } finally { await page.goto('about:blank'); await f.close(); }
});

test('native snapshot confirmation keeps the current editor, active focus and selection', async ({ page, context, isMobile }) => {
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page), pending: Array<() => void> = [];
  let held = true;
  const release = () => { held = false; for (const deliver of pending.splice(0)) deliver(); };
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      const envelope = JSON.parse(String(message)), frame = envelope.message ?? envelope;
      if (held && frame.type === 'agent_snapshot' && frame.payload.runtimeInfo.sessionId === 'B') pending.push(() => route.send(message));
      else route.send(message);
    });
  });
  try {
    f.available(); await f.seed(context, 'Keep this focused selection');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    const closeContext = page.getByRole('button', { name: 'Close Context', exact: true });
    if (isMobile) await expect(closeContext).toBeVisible();
    if (await closeContext.isVisible()) {
      await closeContext.click();
      await expect(closeContext).not.toBeVisible();
    }
    const editor = page.getByTestId('prompt-input'), original = await editor.elementHandle();
    await expect(editor).toBeVisible();
    await expect(editor).toBeEditable();
    await expect(editor).toHaveText('Keep this focused selection');
    await editor.focus();
    await expect(editor).toBeFocused();
    await editor.evaluate(node => {
      const text = node.firstChild!, range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 9);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await expect(editor).toBeFocused();
    const selection = await page.evaluate(() => ({ text: String(window.getSelection()), anchor: window.getSelection()?.anchorOffset, focus: window.getSelection()?.focusOffset }));
    expect(selection).toEqual({ text: 'ep this', anchor: 2, focus: 9 });
    release();
    await expect(page.locator('.lab-has-agent')).toBeVisible();
    expect(await editor.evaluate((node, prior) => node === prior, original)).toBe(true);
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => ({ text: String(window.getSelection()), anchor: window.getSelection()?.anchorOffset, focus: window.getSelection()?.focusOffset }))).toEqual(selection);
    expect(f.controls.filter(item => item.path === '/remote/attach').map(item => item.body.nativeSessionId)).toEqual(['B']);
    expect(inputs).toEqual([]);
  } finally { release(); await page.goto('about:blank'); await f.close(); }
});

test('explicit A history remains concrete across reload on the current device', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page);
  try {
    await f.seed(context, 'Ordinary role draft');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A&intent=history`);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.locator('.lab-has-agent')).toBeVisible(); await expect(page.getByTestId('prompt-input')).toHaveText('');
    await page.getByTestId('prompt-input').fill('A history only');
    await expect.poll(() => page.evaluate(scope => Object.values(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`) ?? '{}')), f.scope)).toContain('A history only');
    await page.reload(); await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.getByTestId('prompt-input')).toHaveText('A history only');
    await expect(page).toHaveURL(/session=A&intent=history/);
    expect(f.controls.filter(item => item.path === '/remote/attach').map(item => item.body.nativeSessionId)).toEqual(['B', 'A', 'A']);
    expect(inputs).toEqual([]);
  } finally { await page.goto('about:blank'); await f.close(); }
});

test('failed composition storage retains desired B and edits until explicit synchronization', async ({ page, context }) => {
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page), subscriptions: string[] = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.type === 'subscribe') subscriptions.push(frame.agentId); }));
  try {
    await f.seed(context, 'Draft before storage failure'); f.available();
    await context.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Object.assign(window, { successionStorageDenied: true });
      Storage.prototype.setItem = function (key, value) {
        if ((window as unknown as { successionStorageDenied: boolean }).successionStorageDenied && key.endsWith(':composition-v2') && JSON.parse(value).roles?.length) throw new Error('Fixture storage unavailable');
        set.call(this, key, value);
      };
    });
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry synchronization', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/session=B/); await expect(page.getByTestId('prompt-input')).toHaveText('Draft before storage failure');
    await page.getByTestId('prompt-input').fill('Edited during storage failure');
    expect(f.controls.filter(item => item.path === '/remote/attach')).toEqual([]); expect(subscriptions).toEqual([]); expect(inputs).toEqual([]);
    await page.evaluate(() => Object.assign(window, { successionStorageDenied: false }));
    await page.getByRole('button', { name: 'Retry synchronization', exact: true }).click();
    await expect(page.locator('.lab-has-agent')).toBeVisible(); await expect(page.getByTestId('prompt-input')).toHaveText('Edited during storage failure');
    expect(f.controls.filter(item => item.path === '/remote/attach').map(item => item.body.nativeSessionId)).toEqual(['B']); expect(inputs).toEqual([]);
  } finally { await page.goto('about:blank'); await f.close(); }
});

test('Ask payload retention failure recovers from the single view document after reload', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Two independent A/B editors are populated before the partial-publication reload.');
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page);
  let committed = false, holdReplay = false, heldRequests = 0, releaseReplay = () => {};
  const replayGate = new Promise<void>(resolve => { releaseReplay = resolve; });
  const routePattern = '**/v1/session-successions**';
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 1, folders: [],
      stars: ['A', 'B'].map((nativeSessionId, order) => ({ hostId: 'browser-host', providerId: 'recorded', nativeSessionId,
        title: nativeSessionId === 'A' ? 'Original primary' : 'Independent B', starredAt: order + 1,
        favoriteId: nativeSessionId, folderId: null, order, available: true, online: true })),
    } }));
    await page.route(routePattern, async route => {
      if (holdReplay) { heldRequests++; await replayGate; }
      if (!committed) await route.fulfill({ json: { version: 1, successions: [], nextCursor: null } });
      else await route.continue();
    });
    f.available(); await f.seed(context, 'A draft before partial publication', 'duplicate');
    await context.addInitScript(() => {
      const set = Storage.prototype.setItem;
      const fault = { active: sessionStorage.getItem('succession-ask-write-fault') === 'true',
        writes: [] as Array<{ key: string; status: 'saved' | 'rejected'; value: string }> };
      Object.assign(window, { successionStorageFault: fault, successionPageIdentity: crypto.randomUUID(), restoreSuccessionStorage: () => { Storage.prototype.setItem = set; } });
      Storage.prototype.setItem = function (key, value) {
        if (fault.active && key.endsWith(':ask:drafts')) {
          fault.writes.push({ key, value, status: 'rejected' }); throw new Error('Fixture Ask owner publication unavailable');
        }
        set.call(this, key, value);
        if (fault.active && key.endsWith(':composition-v2')) fault.writes.push({ key, value, status: 'saved' });
      };
    });
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    const primary = page.locator('.lab-primary-conversation');
    const independent = page.locator('.lab-side-conversation').filter({ has: page.getByText('Independent B', { exact: true }) });
    await expect(primary).toBeVisible();
    await expect(primary.getByTestId('prompt-input')).toHaveText('A draft before partial publication');
    await page.getByRole('button', { name: 'Expand window 2: Independent B', exact: true }).click();
    await expect(independent).toBeVisible();
    await expect(independent.getByTestId('prompt-input')).toHaveText('Side local draft');
    const returnToPrimary = page.getByRole('button', { name: 'Expand window 1: Original primary', exact: true });
    if (await returnToPrimary.isVisible()) await returnToPrimary.click();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64');
    // Recorded sessions have no image-input capability. Seed previously saved
    // drafts in the actual two-store schema; the product owns their recovery.
    await page.evaluate(async ({ scope, bytes }) => {
      await new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open('agent-remote-image-drafts', 2);
        opened.onerror = () => reject(opened.error);
        opened.onupgradeneeded = () => {
          if (!opened.result.objectStoreNames.contains('drafts')) opened.result.createObjectStore('drafts', { keyPath: 'key' });
          if (!opened.result.objectStoreNames.contains('images')) opened.result.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
        };
        opened.onsuccess = () => {
          const database = opened.result, tx = database.transaction(['drafts', 'images'], 'readwrite');
          tx.oncomplete = () => { database.close(); resolve(); };
          tx.onabort = () => { database.close(); reject(tx.error); };
          for (const [nativeSessionId, text] of [['A', 'A draft before partial publication'], ['B', 'Side local draft']]) {
            const key = JSON.stringify([scope, JSON.stringify(['browser-host', 'recorded', nativeSessionId])]);
            const imageId = `owner-${nativeSessionId}-image`, blobKey = JSON.stringify([key, imageId]);
            tx.objectStore('images').put({ key: blobKey, scope, imageId, blobBytes: Uint8Array.from(bytes).buffer, blobMediaType: 'image/png' });
            tx.objectStore('drafts').put({ version: 1, key, scope, parts: [{ type: 'text', text }, { type: 'image', imageId, label: `Owner ${nativeSessionId} image` }],
              images: { [imageId]: { imageId, blobKey, uploadId: `owner-${nativeSessionId}-upload`, status: 'pending', progress: 0 } }, nextLabel: 2 });
          }
        };
      });
    }, { scope: f.scope, bytes: [...bytes] });
    await expect.poll(async () => (await storedImageBytes(page)).length).toBe(2);
    const images = await storedImageBytes(page);
    for (const image of images) { expect(image.bytes).toEqual([...bytes]); expect(image.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); }
    const before = await page.evaluate(scope => ({
      identity: (window as unknown as { successionPageIdentity: string }).successionPageIdentity,
      track: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).tracks,
      drafts: sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`),
      askDrafts: sessionStorage.getItem(`agent-remote:recovery:${scope}:ask:drafts`),
    }), f.scope);
    await testInfo.attach('before-publication.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(before, null, 2)) });
    expect(before.track.map((entry: { view: { primarySlot: string } }) => entry.view.primarySlot)).toEqual([
      JSON.stringify(['browser-host', 'recorded', 'A']), JSON.stringify(['browser-host', 'recorded', 'B']),
    ]);
    await page.evaluate(() => {
      sessionStorage.setItem('succession-ask-write-fault', 'true');
      (window as unknown as { successionStorageFault: { active: boolean } }).successionStorageFault.active = true;
    });
    committed = true;
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
    await expect(page.getByRole('button', { name: 'Retry synchronization', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/session=B/);
    const partial = await page.evaluate(scope => ({
      composition: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!),
      track: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).tracks,
      ask: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).asks,
      writes: (window as unknown as { successionStorageFault: { writes: Array<{ key: string; status: string; value: string }> } }).successionStorageFault.writes,
    }), f.scope);
    const successful = partial.writes.findIndex(write => write.status === 'saved' && JSON.parse(write.value).roles?.some((role: { desired: { committedRevision: number } }) => role.desired.committedRevision === 2));
    expect(successful).toBeGreaterThanOrEqual(0);
    expect(partial.writes.findIndex(write => write.status === 'rejected')).toBeGreaterThan(successful);
    expect(partial.composition.roles[0].desired.to.nativeSessionId).toBe('B');
    expect(partial.composition.roles[0].appliedRevision).toBeLessThan(2);
    expect(partial.composition.roles[0].documents.ask.status).toBe('failed');
    await testInfo.attach('partial-publication.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(partial, null, 2)) });
    await page.screenshot({ path: testInfo.outputPath('partial-publication.png'), fullPage: true });
    const attachCount = f.controls.filter(item => item.path === '/remote/attach').length;
    holdReplay = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => heldRequests).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { successionPageIdentity: string }).successionPageIdentity)).not.toBe(before.identity);
    expect(f.controls.filter(item => item.path === '/remote/attach')).toHaveLength(attachCount);
    expect(await page.evaluate(scope => JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).roles[0].appliedRevision, f.scope)).toBeLessThan(2);
    const recoveryReadStart = f.reads.length;
    await page.evaluate(() => {
      sessionStorage.removeItem('succession-ask-write-fault');
      (window as unknown as { successionStorageFault: { active: boolean } }).successionStorageFault.active = false;
    });
    holdReplay = false; releaseReplay();
    await expect.poll(() => page.evaluate(scope => JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).roles[0].appliedRevision, f.scope)).toBe(2);
    await expect(primary.getByTestId('prompt-input')).toContainText('A draft before partial publication');
    await expect(primary.locator('[data-image-id]')).toHaveCount(1);
    expect(await storedImageBytes(page)).toEqual(images);
    const recovered = await page.evaluate(scope => ({
      composition: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!),
      track: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).tracks,
      ask: JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`)!).asks,
      drafts: sessionStorage.getItem(`agent-remote:recovery:${scope}:drafts`),
      askDrafts: sessionStorage.getItem(`agent-remote:recovery:${scope}:ask:drafts`),
    }), f.scope);
    await testInfo.attach('recovered-owners.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ ...recovered, controls: f.controls, reads: f.reads.slice(recoveryReadStart), inputs, images }, null, 2)) });
    await page.screenshot({ path: testInfo.outputPath('partial-reload-recovered.png'), fullPage: true });
    expect(JSON.parse(recovered.drafts!)).toEqual(JSON.parse(before.drafts!));
    expect(recovered.askDrafts).toBe(before.askDrafts);
    const a = recovered.composition.slots.find((slot: { owners: { text: { key: string } } }) => slot.owners.text.key === 'agent-A');
    const b = recovered.composition.slots.find((slot: { owners: { text: { key: string } }; intent: { target: { native: { nativeSessionId: string } } } }) => slot.owners.text.key !== 'agent-A' && slot.intent.target.native.nativeSessionId === 'B');
    expect(a.intent.target.native.nativeSessionId).toBe('B'); expect(b).toBeDefined();
    expect(recovered.composition.retained).toContainEqual({ slot: b.id, against: a.id });
    expect(recovered.ask.map((owner: { sourceSlot: string }) => owner.sourceSlot)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(recovered.track.map((entry: { view: { primarySlot: string } }) => entry.view.primarySlot)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(f.reads.slice(recoveryReadStart).some(path => path.includes('/session-successions/current'))).toBe(true);
    // The enabled Ask retains an activity observer for its own native target after reload.
    expect(f.controls.filter(item => item.path === '/remote/attach').slice(attachCount).map(item => item.body.nativeSessionId)).toEqual(['B', 'T']);
    expect(inputs).toEqual([]);
    const beforeLocalNavigation = f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'B').length;

    await primary.locator('.lab-chat-sessions-heading').click();
    await testInfo.attach('retained-navigation.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      url: page.url(), buttons: await page.locator('button:visible').allTextContents(),
      sessions: await primary.getByRole('region', { name: 'Chat sessions', exact: true }).innerText(),
    }, null, 2)) });
    await page.screenshot({ path: testInfo.outputPath('retained-navigation.png'), fullPage: true });
    const retainedB = page.getByRole('button', { name: /Independent B/ });
    await expect(retainedB).toBeVisible(); await retainedB.click();
    await expect(primary.getByTestId('prompt-input')).toContainText('Side local draft');
    await expect(primary.locator('[data-image-id]')).toHaveAttribute('data-image-id', 'owner-B-image');
    await primary.getByRole('button', { name: 'Ask about this session', exact: true }).click();
    const ask = primary.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask.getByTestId('prompt-input')).toHaveText('B Ask draft');
    await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
    await primary.locator('.lab-chat-sessions-heading').click();
    await primary.getByRole('button', { name: /Original primary.*Saved view/ }).click();
    await expect(primary.getByTestId('prompt-input')).toContainText('A draft before partial publication');
    await expect(primary.locator('[data-image-id]')).toHaveAttribute('data-image-id', 'owner-A-image');
    await primary.getByRole('button', { name: 'Ask about this session', exact: true }).click();
    await expect(ask.getByTestId('prompt-input')).toHaveText('A Ask draft');
    await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const expandActions = primary.getByRole('button', { name: 'Expand session actions', exact: true });
    await expect(expandActions).toBeVisible();
    await expandActions.click();
    const moreActions = primary.getByRole('button', { name: 'More session actions', exact: true });
    if (await moreActions.isVisible()) await moreActions.click();
    await primary.locator('.lab-chat-sessions-heading').click();
    await primary.getByRole('button', { name: /Independent B.*Saved view/ }).click();
    await expect(primary.getByTestId('prompt-input')).toContainText('Side local draft');
    await expect(primary.locator('[data-image-id]')).toHaveAttribute('data-image-id', 'owner-B-image');
    expect(f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'B')).toHaveLength(beforeLocalNavigation);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(primary.getByTestId('prompt-input')).toContainText('Side local draft');
    await expect(primary.locator('[data-image-id]')).toHaveAttribute('data-image-id', 'owner-B-image');
    await page.screenshot({ path: testInfo.outputPath('retained-compact-reloaded.png'), fullPage: true });
    expect(await storedImageBytes(page)).toEqual(images); expect(inputs).toEqual([]);
  } finally {
    holdReplay = false; releaseReplay();
    try {
      await page.evaluate(() => { sessionStorage.removeItem('succession-ask-write-fault'); (window as unknown as { restoreSuccessionStorage?: () => void }).restoreSuccessionStorage?.(); }).catch(() => {});
      await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
      await page.goto('about:blank').catch(() => {});
    } finally { await f.close(); }
  }
});

for (const coldRecovery of [false, true]) test(`${coldRecovery ? 'Cold recovery restores' : 'Side selection and collapse retain'} an independent Ask window through B failure and Retry`, async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'The desktop case keeps two Side panes and their floating Ask visible.');
  test.setTimeout(60000);
  const f = await fixture(), inputs = observeInputs(page);
  let committed = coldRecovery;
  await page.route('**/v1/session-successions**', async route => {
    if (!committed && new URL(route.request().url()).pathname.endsWith('/session-successions')) await route.fulfill({ json: { version: 1, successions: [], nextCursor: null } });
    else await route.continue();
  });
  try {
    await f.seed(context, 'Primary role draft', 'nested-ask');
    await page.goto(`${f.origin}/?host=browser-host&provider=recorded&session=A`);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('button', { name: 'Close Context', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close Context', exact: true }).click();
    const side = page.locator('.lab-side-conversation').filter({ has: page.locator('.lab-side-title-text', { hasText: 'Independent Side' }) });
    const ask = side.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask).toBeVisible(); await expect(ask.getByTestId('prompt-input')).toHaveText('Independent Ask draft');
    await expect(ask.getByText('Recorded history 2', { exact: true })).toBeVisible();
    await expect(side.locator(':scope > .lab-session-view').getByTestId('prompt-input')).toHaveText('Side local draft');
    const primary = page.locator('.lab-primary-conversation');
    await expect(primary).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand window 1: Original primary', exact: true })).toBeVisible();
    const askEditor = await ask.getByTestId('prompt-input').elementHandle();
    const sourceAttaches = f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'A').length;
    if (coldRecovery) expect(sourceAttaches).toBe(0); else expect(sourceAttaches).toBeGreaterThan(0);
    if (!coldRecovery) {
      committed = true;
      await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
    }
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
    expect(await ask.getByTestId('prompt-input').evaluate((node, original) => node === original, askEditor)).toBe(true);
    const before = await page.evaluate(scope => {
      const saved = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`) ?? '{}');
      return { primarySlot: saved.slots.find((slot: { owners: { text: { key: string } } }) => slot.owners.text.key === 'agent-A').id,
        focus: saved.focus, anchor: saved.anchor, collapsed: saved.collapsed, edges: saved.edges,
        windows: saved.asks.filter((owner: { open: boolean }) => owner.open).map((owner: { id: string }) => owner.id), geometry: Object.fromEntries(Object.keys(localStorage).filter(key => key.includes(':window-')).map(key => [key, localStorage.getItem(key)])) };
    }, f.scope);
    const targetAttaches = f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'T').length;
    expect(targetAttaches).toBe(1);
    f.available(); await page.getByRole('button', { name: 'Retry session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toHaveCount(0);
    await expect(ask.getByTestId('prompt-input')).toHaveText('Independent Ask draft');
    expect(await ask.getByTestId('prompt-input').evaluate((node, original) => node === original, askEditor)).toBe(true);
    await expect(primary).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand window 1: Original primary', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(scope => {
      const saved = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`) ?? '{}');
      return { primarySlot: saved.slots.find((slot: { owners: { text: { key: string } } }) => slot.owners.text.key === 'agent-A').id,
        focus: saved.focus, anchor: saved.anchor, collapsed: saved.collapsed, edges: saved.edges,
        windows: saved.asks.filter((owner: { open: boolean }) => owner.open).map((owner: { id: string }) => owner.id), geometry: Object.fromEntries(Object.keys(localStorage).filter(key => key.includes(':window-')).map(key => [key, localStorage.getItem(key)])) };
    }, f.scope)).toEqual({ ...before, collapsed: [before.primarySlot] });
    expect(f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'T')).toHaveLength(targetAttaches);
    expect(f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'B')).toHaveLength(2);
    expect(f.controls.filter(item => item.path === '/remote/attach' && item.body.nativeSessionId === 'A')).toHaveLength(sourceAttaches);
    await page.locator('.lab-side-title-text').getByText('Nested Side', { exact: true }).click();
    await expect.poll(() => page.evaluate(scope => {
      const saved = JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:composition-v2`) ?? '{}');
      const focused = saved.slots?.find((slot: { id: string }) => slot.id === saved.focus);
      return focused?.intent.target.nativeSessionId ?? focused?.intent.target.native?.nativeSessionId;
    }, f.scope)).toBe('U');
    expect(await ask.getByTestId('prompt-input').evaluate((node, original) => node === original, askEditor)).toBe(true);
    expect(inputs).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('side-ask-retained.png'), fullPage: true });
  } finally { await page.goto('about:blank'); await f.close(); }
});
