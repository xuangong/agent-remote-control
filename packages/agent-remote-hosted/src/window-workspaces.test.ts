import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createHostedRelay } from './gateway.js';
import { createServer, type Server } from 'node:http';
import { createWindowView, decodeWorkspaceWindow, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
import { createWindowWorkspaces } from './window-workspaces.js';
import { handleWindowRequest } from './window-routes.js';
import { encodeHostedSnapshot, decodeHostedSnapshot } from './record-codec.js';
const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'windows-test-secret-01234567890123456789' };
const binding = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Session' };
const window = (): WorkspaceWindow => ({ schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: 'primary', selectedViewId: 'primary', views: [createWindowView('primary', binding, 'primary')] });
const servers: Server[] = []; const cleanups: Array<() => void> = [];
afterEach(async () => { cleanups.splice(0).forEach(fn => fn()); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function fixture(initial?: HostedRelayState) {
  let saved = initial ?? emptyRelayState(auth); let clock = Date.now(); let allowed = true;
  const state = createRelayState(auth, { initial: saved, async commit(next) { saved = structuredClone(next); } }, () => {}, () => {});
  const service = createWindowWorkspaces(state, (subject, session) => allowed && subject === 'alice' && session.hostId === 'host', () => clock);
  cleanups.push(() => service.close());
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const controller = new AbortController(); res.on('close', () => controller.abort());
    const principal = { subject: String(req.headers['x-user'] ?? 'alice'), authorize: () => req.headers['x-expire'] !== 'true' || allowed };
    try {
      const request = new Request('http://localhost' + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal });
      const response = await handleWindowRequest(service, request, principal);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(503); res.end('{}'); }
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}/v1/windows`;
  const call = async (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => { const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() as any }; };
  const create = () => call('', 'POST', { operationId: 'create', issuedAt: clock, window: window() });
  const mutation = (operationId: string, baseRevision: number, operation: unknown) => ({ operationId, issuedAt: clock, baseRevision, operation });
  return { service, state, call, create, mutation, saved: () => saved, tick: (ms: number) => { clock += ms; }, deny: () => { allowed = false; } };
}
it('preserves historical and current bindings together through HTTP mutations and storage restart', async () => {
  const f = await fixture(); await f.create();
  const history = { ...binding, sessionIntent: 'history' as const };
  const input = f.mutation('history', 0, { type: 'batch', operations: [
    { type: 'view.bind', viewId: 'primary', binding: history },
    { type: 'view.create', view: createWindowView('other', { ...binding, nativeSessionId: 'live' }, 'primary') },
    { type: 'view.select', viewId: 'other' },
  ] });
  expect((await f.call('/window/operations', 'POST', input)).body.result.status).toBe('committed');
  const records = [...encodeHostedSnapshot(f.saved(), auth).records.values()];
  const restored = decodeHostedSnapshot(records.map(row => row.manifest), records.flatMap(row => row.chunks), auth);
  const restarted = await fixture(restored);
  const snapshot = (await restarted.call('/window')).body.window;
  expect(snapshot.selectedPrimaryViewId).toBe('other');
  expect(snapshot.views[0].binding).toEqual(history);
  expect(snapshot.views[1].binding).toEqual({ ...binding, nativeSessionId: 'live' });
  const selected = await restarted.call('/window/operations', 'POST', restarted.mutation('select-history', snapshot.revision, { type: 'view.select', viewId: 'primary' }));
  expect(selected.body.window.views[0].binding).toEqual(history);
}, 10000);

it('shares committed state across HTTP clients, rejects stale revisions, and deduplicates lost responses across restart', async () => {
  const f = await fixture(); expect((await f.create()).status).toBe(200);
  const input = f.mutation('add', 0, { type: 'view.create', view: createWindowView('dock') });
  const first = await f.call('/window/operations', 'POST', input); expect(first.body.result).toMatchObject({ status: 'committed', revision: 1 });
  expect((await f.call('/window')).body.window.views).toHaveLength(2);
  expect((await f.call('/window/operations', 'POST', input)).body).toEqual(first.body);
  expect((await f.call('/window/operations', 'POST', { ...input, baseRevision: 1 })).status).toBe(409);
  expect((await f.call('/window/operations', 'POST', f.mutation('stale', 0, { type: 'rename', title: 'Stale' }))).body.result.code).toBe('revision_conflict');
  expect((await f.call('/window', 'GET', undefined, { 'x-user': 'bob' })).status).toBe(404);
  const snapshot = encodeHostedSnapshot(f.saved(), auth); const records = [...snapshot.records.values()];
  const restored = decodeHostedSnapshot(records.map(row => row.manifest), records.flatMap(row => row.chunks), auth);
  expect(validateRelayState(restored, auth)).toEqual(f.saved());
  const forged = structuredClone(records);
  const forgedRecord = forged.find(record => record.manifest.kind === 'workspaceWindow')!;
  const forgedEnvelope = JSON.parse(new TextDecoder().decode(forgedRecord.chunks[0]!.bytes));
  forgedEnvelope.payload.id = forgedEnvelope.payload.window.id = 'different-window';
  const forgedBytes = new TextEncoder().encode(JSON.stringify(forgedEnvelope));
  forgedRecord.chunks = [{ ...forgedRecord.chunks[0]!, bytes: forgedBytes }];
  forgedRecord.manifest = { ...forgedRecord.manifest, byte_length: forgedBytes.byteLength, digest: createHash('sha256').update(forgedBytes).digest('hex') };
  expect(() => decodeHostedSnapshot(forged.map(record => record.manifest), forged.flatMap(record => record.chunks), auth)).toThrow('payload identity or header mismatch');
  const restarted = await fixture(restored);
  expect((await restarted.call('/window/operations/add')).body.result).toEqual(first.body.result);
  expect((await restarted.call('/window/operations', 'POST', input)).body).toEqual(first.body);
});
it('records the session assigned to arrange a Window, which issues no credential of its own', async () => {
  const f = await fixture(); await f.create();
  const assigned = await f.call('/window/manager', 'POST', { session: binding });
  expect(assigned.body).toEqual({ generation: 1, manager: { session: binding, generation: 1 } });
  expect((await f.call('/window')).body.manager).toEqual({ session: binding, generation: 1 });
  expect((await f.call('/window/manager', 'POST', { session: { ...binding, hostId: 'foreign' } })).status).toBe(403);
  expect((await f.call('/window/manager', 'POST', { session: binding }, { 'x-user': 'bob' })).status).toBe(404);
  await f.call('/window/manager', 'POST', { session: null });
  expect((await f.call('/window')).body).not.toHaveProperty('manager');
  expect(f.saved().workspaceWindows![0]!.manager).toBeUndefined();
});
it('validates all bindings atomically, retains delete receipts and rejects resurrection and expired operations', async () => {
  const f = await fixture(); await f.create();
  const invalid = f.mutation('invalid', 0, { type: 'view.bind', viewId: 'primary', binding: { ...binding, hostId: 'foreign' } });
  expect((await f.call('/window/operations', 'POST', invalid)).body.result.code).toBe('session_forbidden');
  expect((await f.call('/window')).body.window.revision).toBe(0);
  const deletion = f.mutation('delete', 0, { type: 'delete' }); const deleted = await f.call('/window', 'DELETE', deletion);
  expect(deleted.body.result).toMatchObject({ status: 'committed', revision: 1 });
  expect((await f.call('/window', 'DELETE', deletion)).body).toEqual(deleted.body);
  expect((await f.call('/window/operations/delete')).body.result).toEqual(deleted.body.result);
  expect((await f.call('/window')).status).toBe(404);
  expect((await f.create()).body.result.status).toBe('committed'); // Same create receipt resolves its original outcome.
  expect((await f.call('', 'POST', { operationId: 'resurrect', issuedAt: Date.now(), window: window() })).body.result.code).toBe('window_exists');
  f.tick(24 * 60 * 60 * 1000 + 1);
  expect((await f.call('/window/operations/delete')).status).toBe(410);
  expect((await f.call('/window', 'DELETE', deletion)).status).toBe(410);
});
it('wakes bounded subscriptions, checks authorization at completion, and releases waiters on shutdown', async () => {
  const f = await fixture(); await f.create();
  const pending = f.service.changes({ subject: 'alice' }, 'window', 0, undefined, 500);
  await f.call('/window/operations', 'POST', f.mutation('rename', 0, { type: 'rename', title: 'Shared' }));
  expect((await pending).window.title).toBe('Shared');
  const revoked = f.service.changes({ subject: 'alice', authorize: () => false }, 'window', 1, undefined, 5); await expect(revoked).rejects.toMatchObject({ status: 401 });
  let authorized = true;
  const waiting = f.service.changes({ subject: 'alice', authorize: () => authorized }, 'window', 1, undefined, 10);
  authorized = false; await expect(waiting).rejects.toMatchObject({ status: 401 });
  const controller = new AbortController(); const canceled = f.service.changes({ subject: 'alice' }, 'window', 1, controller.signal); controller.abort(); await expect(canceled).rejects.toMatchObject({ status: 499 });
  const stopped = f.service.changes({ subject: 'alice' }, 'window', 1); f.service.close(); await expect(stopped).rejects.toMatchObject({ status: 401 });
});
it('bounds streamed HTTP bodies before allocating the JSON document', async () => {
  const f = await fixture(); let produced = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { produced++; controller.enqueue(new Uint8Array(100000)); } });
  const response = await handleWindowRequest(f.service, new Request('http://localhost/v1/windows', { method: 'POST', body, duplex: 'half' } as RequestInit), { subject: 'alice' });
  expect(response.status).toBe(413); expect(produced).toBeLessThanOrEqual(5);
});
it('publishes the document and its result together only after storage commits', async () => {
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const committing = new Promise<void>(resolve => { entered = resolve; });
  const state = createRelayState(auth, { async commit() { entered(); await held; } }, () => {}, () => {});
  const service = createWindowWorkspaces(state, () => true); cleanups.push(() => service.close());
  const create = service.create({ subject: 'alice' }, { operationId: 'durable', issuedAt: Date.now(), window: window() });
  await committing;
  expect(service.list({ subject: 'alice' }).windows).toEqual([]);
  release(); await create;
  expect(service.inspect({ subject: 'alice' }, 'window').window.id).toBe('window');
  expect(service.operation({ subject: 'alice' }, 'window', 'durable').result.status).toBe('committed');
});
it('serves Windows only in the signed-in user\'s namespace, not to bearer credentials', async () => {
  const initial = emptyRelayState(auth);
  initial.workspaceWindows = [{ subject: 'alice', id: 'window', window: { ...window(), views: [createWindowView('primary', undefined, 'primary')] }, generation: 1, manager: { session: binding, generation: 1 }, receipts: [] }];
  const relay = createHostedRelay({ ...auth, storage: { initial, async commit() {} }, scheduler: { schedule() {}, cancel() {} } });
  const headers = { authorization: 'Bearer ' + 't'.repeat(43), 'content-type': 'application/json' };
  try {
    expect((await relay.fetch(new Request(auth.origin + '/v1/windows/window', { headers })))?.status).toBe(401);
    expect((await relay.fetch(new Request(auth.origin + '/u/alice/v1/windows/window', { headers })))?.status).toBe(401);
  } finally { await relay.close(); }
});
it('retains only settlement metadata and returns the current layout alongside a retried result', async () => {
  const f = await fixture(); await f.create();
  const original = f.mutation('first', 0, { type: 'rename', title: 'First' });
  const first = await f.call('/window/operations', 'POST', original);
  await f.call('/window/operations', 'POST', f.mutation('second', 1, { type: 'rename', title: 'Second' }));
  const retry = await f.call('/window/operations', 'POST', original);
  expect(retry.body.result).toEqual(first.body.result);
  expect(retry.body.window).toMatchObject({ revision: 2, title: 'Second' });
  expect(f.saved().workspaceWindows![0]!.receipts.every(receipt => Object.keys(receipt).sort().join(',') === 'fingerprint,result')).toBe(true);
  const before = f.saved();
  await expect(f.service.mutate({ subject: 'alice' }, 'window', { ...f.mutation('giant', 2, { type: 'rename', title: 'x'.repeat(400000) }) } as any)).rejects.toMatchObject({ status: 413 });
  expect(f.saved()).toBe(before);
});

it('authorizes actual native bindings without interpreting opaque feature Host metadata', async () => {
  const f = await fixture(); await f.create();
  const association = { kind: 'external', id: 'tool', metadata: { hostId: 'foreign', sourceViewId: 'missing' } };
  const tag = await f.call('/window/operations', 'POST', f.mutation('opaque', 0, {
    type: 'view.create', view: { ...createWindowView('tagged'), feature: association },
  }));
  expect(tag.body.result.status).toBe('committed');
  const native = await f.call('/window/operations', 'POST', f.mutation('foreign-binding', 1, {
    type: 'view.bind', viewId: 'tagged', binding: { ...binding, hostId: 'foreign' },
  }));
  expect(native.body.result).toMatchObject({ status: 'rejected', code: 'session_forbidden' });
  expect((await f.call('/window')).body.window.views[1].feature).toEqual(association);
});
it('shares independent primary groups through HTTP selection, closure, subscriptions and durable reload', async () => {
  const f = await fixture(); expect((await f.create()).status).toBe(200);
  const create = f.mutation('second-primary', 0, { type: 'view.create', view: createWindowView('second', binding, 'primary') });
  expect((await f.call('/window/operations', 'POST', create)).body.result.status).toBe('committed');
  const selected = f.mutation('select-second', 1, { type: 'view.select', viewId: 'second' });
  const waiting = f.call('/window/changes?afterRevision=1');
  await f.call('/window/operations', 'POST', selected);
  expect((await waiting).body.window.selectedPrimaryViewId).toBe('second');
  const initial = structuredClone(f.saved());
  const snapshot = encodeHostedSnapshot(initial, auth), records = [...snapshot.records.values()];
  const restarted = await fixture(decodeHostedSnapshot(records.map(row => row.manifest), records.flatMap(row => row.chunks), auth));
  expect((await restarted.call('/window')).body.window.views.map((view: any) => view.id)).toEqual(['primary', 'second']);
  expect((await restarted.call('/window/operations', 'POST', create)).body.result.revision).toBe(1);
  const closed = await restarted.call('/window/operations', 'POST', restarted.mutation('close-primary', 2, { type: 'view.close', viewId: 'primary' }));
  expect(closed.body.window).toMatchObject({ selectedPrimaryViewId: 'second', selectedViewId: 'second' });
  const empty = await restarted.call('/window/operations', 'POST', restarted.mutation('close-last', 3, { type: 'view.close', viewId: 'second' }));
  expect(empty.body.result.status).toBe('committed');
  expect(empty.body.window).toMatchObject({ id: 'window', revision: 4, views: [], selectedViewId: null, selectedPrimaryViewId: null });
});
it.each([1, 2] as const)('migrates legacy persisted Windows while replaying original v%s request fingerprints unchanged', async version => {
  const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const f = await fixture();
  const { selectedPrimaryViewId, ...base } = window();
  const legacy = version === 1
    ? { ...base, schemaVersion: 1, revision: 1, primaryViewId: selectedPrimaryViewId, mainMinimized: false }
    : { ...base, schemaVersion: 2, revision: 1, selectedPrimaryViewId };
  const oldCreate = { operationId: 'old-create', issuedAt: Date.now(), window: { ...legacy, revision: 0 } };
  const oldEdit = { operationId: 'old-layout', issuedAt: Date.now(), baseRevision: 0, operation: { type: 'layout.apply', layout: {
    title: legacy.title, selectedViewId: legacy.selectedViewId, views: legacy.views,
    ...(version === 1 ? { primaryViewId: selectedPrimaryViewId, mainMinimized: false } : { selectedPrimaryViewId }),
  } } };
  const result = (operationId: string, revision: number) => ({ operationId, status: 'committed' as const, revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000 });
  const initial = f.saved();
  initial.workspaceWindows = [{ subject: 'alice', id: legacy.id, generation: 0, window: legacy as any,
    receipts: [oldCreate, oldEdit].map((input, index) => ({ fingerprint: createHash('sha256').update(canonical(input)).digest('hex'), result: result(input.operationId, index) })) }];
  const persisted = encodeHostedSnapshot(initial, auth);
  const records = [...persisted.records.values()];
  const physical = records.find(record => record.manifest.kind === 'workspaceWindow')!;
  const envelope = JSON.parse(new TextDecoder().decode(physical.chunks[0]!.bytes));
  envelope.payload.window = legacy;
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  physical.chunks = [{ ...physical.chunks[0]!, bytes }];
  physical.manifest = { ...physical.manifest, byte_length: bytes.byteLength, chunk_count: 1, digest: createHash('sha256').update(bytes).digest('hex') };
  const restored = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
  const forged = structuredClone(records);
  const forgedRecord = forged.find(record => record.manifest.kind === 'workspaceWindow')!;
  const forgedEnvelope = JSON.parse(new TextDecoder().decode(forgedRecord.chunks[0]!.bytes));
  forgedEnvelope.payload.id = forgedEnvelope.payload.window.id = 'different-window';
  const forgedBytes = new TextEncoder().encode(JSON.stringify(forgedEnvelope));
  forgedRecord.chunks = [{ ...forgedRecord.chunks[0]!, bytes: forgedBytes }];
  forgedRecord.manifest = { ...forgedRecord.manifest, byte_length: forgedBytes.byteLength, digest: createHash('sha256').update(forgedBytes).digest('hex') };
  expect(() => decodeHostedSnapshot(forged.map(record => record.manifest), forged.flatMap(record => record.chunks), auth)).toThrow('payload identity or header mismatch');
  const restarted = await fixture(restored);
  expect((await restarted.call('/window')).body.window).toMatchObject({ schemaVersion: 3, id: 'window', revision: 1, selectedPrimaryViewId: 'primary' });
  expect((await restarted.call('', 'POST', oldCreate)).body.result).toEqual(initial.workspaceWindows[0]!.receipts[0]!.result);
  expect((await restarted.call('/window/operations', 'POST', oldEdit)).body.result).toEqual(initial.workspaceWindows[0]!.receipts[1]!.result);
  expect((await restarted.call('/window/operations', 'POST', { ...oldEdit, baseRevision: 5 })).status).toBe(409);
  expect((await restarted.call('', 'POST', { ...oldCreate, operationId: 'new-legacy' })).status).toBe(400);
  if (version === 1) expect((await restarted.call('/window/operations', 'POST', { ...oldEdit, operationId: 'new-legacy-layout' })).status).toBe(400);
  expect(initial.workspaceWindows[0]!.window).toEqual(legacy);
});

it('retains an empty Window, its manager and close receipt across HTTP subscription and durable restart', async () => {
  const f = await fixture(); await f.create();
  await f.call('/window/manager', 'POST', { session: binding });
  const headers = {};
  const close = f.mutation('close-last', 0, { type: 'view.close', viewId: 'primary' });
  const waiting = f.call('/window/changes?afterRevision=0', 'GET', undefined, headers);
  const closed = await f.call('/window/operations', 'POST', close, headers);
  const empty = { ...window(), revision: 1, views: [], selectedViewId: null, selectedPrimaryViewId: null };
  expect(closed.body).toMatchObject({ result: { status: 'committed', revision: 1 }, window: empty });
  expect((await waiting).body.window).toEqual(empty);
  expect((await f.call('', 'GET', undefined, headers)).body.windows).toEqual([empty]);
  expect(f.saved().workspaceWindows![0]!.deleted).toBeUndefined();
  const records = [...encodeHostedSnapshot(f.saved(), auth).records.values()];
  const restored = decodeHostedSnapshot(records.map(row => row.manifest), records.flatMap(row => row.chunks), auth);
  const restarted = await fixture(restored);
  expect((await restarted.call('/window', 'GET', undefined, headers)).body.window).toEqual(empty);
  expect((await restarted.call('/window/operations', 'POST', close, headers)).body).toEqual(closed.body);
  const create = restarted.mutation('first-dock', 1, { type: 'view.create', view: createWindowView('dock', binding) });
  const opened = await restarted.call('/window/operations', 'POST', create, headers);
  expect(opened.body).toMatchObject({ result: { status: 'committed', revision: 2 }, window: { id: 'window', selectedViewId: 'dock', selectedPrimaryViewId: null } });
  expect(opened.body.window.views).toEqual([createWindowView('dock', binding)]);
  const replay = await restarted.call('/window/operations', 'POST', close, headers);
  expect(replay.body.result).toEqual(closed.body.result);
  expect(replay.body.window).toEqual(opened.body.window);
});

it('creates an empty Window through HTTP without synthesizing a primary pane', async () => {
  const f = await fixture();
  const empty = { ...window(), views: [], selectedViewId: null, selectedPrimaryViewId: null };
  const created = await f.call('', 'POST', { operationId: 'empty-create', issuedAt: Date.now(), window: empty });
  expect(created.body).toMatchObject({ result: { status: 'committed' }, window: empty });
  expect((await f.call('/window')).body.window).toEqual(empty);
});

const sectionWindow = (id: string, nativeSessionId: string, title = 'Release'): WorkspaceWindow => ({ schemaVersion: 3, id, title, revision: 0,
  selectedPrimaryViewId: 'writer', selectedViewId: 'writer', views: [createWindowView('writer', { ...binding, nativeSessionId }, 'primary')] });

it('lists every group, keeping sections without a Window out of the list older pages read', async () => {
  const f = await fixture(); await f.create();
  const created = await f.call('', 'POST', { operationId: 'create-section', issuedAt: Date.now(), window: sectionWindow('section', 'writer'),
    bots: { rank: 'm', members: { writer: { label: 'Writer' } } }, presentation: { window: false } });
  expect(created.body).toMatchObject({ result: { status: 'committed' }, bots: { rank: 'm' }, presentation: { window: false } });
  const listed = await f.call();
  expect(listed.body.windows.map((window: WorkspaceWindow) => window.id)).toEqual(['window']);
  expect(listed.body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window', 'section']);
  // An older page decodes every Window it is given.
  expect(listed.body.windows.every((window: unknown) => decodeWorkspaceWindow(window))).toBe(true);
  expect((await f.call('/section')).body).toMatchObject({ bots: { members: { writer: { label: 'Writer' } } }, presentation: { window: false } });
  const restarted = await fixture(f.saved());
  expect((await restarted.call('/section')).body.presentation).toEqual({ window: false });
});

it('refuses malformed stored groups and ignores what an older Worker leaves behind', async () => {
  const f = await fixture(); await f.create();
  const saved = structuredClone(f.saved());
  const row = saved.workspaceWindows![0]!;
  expect(validateRelayState({ ...saved, workspaceWindows: [{ ...row, bots: { rank: 'm', members: {} } }] }, auth).workspaceWindows![0]!.bots).toEqual({ rank: 'm', members: {} });
  // Bot mode shows a group without bot details, so hiding its Window is valid; hiding it in both modes or an empty presentation is not.
  expect(validateRelayState({ ...saved, workspaceWindows: [{ ...row, presentation: { window: false } }] }, auth).workspaceWindows![0]!.presentation).toEqual({ window: false });
  expect(() => validateRelayState({ ...saved, workspaceWindows: [{ ...row, presentation: { window: false, bots: false } }] }, auth)).toThrow();
  expect(() => validateRelayState({ ...saved, workspaceWindows: [{ ...row, presentation: {} }] }, auth)).toThrow();
  expect(() => validateRelayState({ ...saved, workspaceWindows: [{ ...row, bots: { rank: 'M', members: {} } }] }, auth)).toThrow();
  // An older Worker keeps details for a view it closed, and keeps the section of a group it deleted.
  const left = { ...saved, workspaceWindows: [
    { ...row, bots: { rank: 'm', members: { missing: { label: 'Gone' } } } },
    { subject: 'alice', id: 'gone', deleted: true as const, generation: 0, receipts: [], bots: { rank: 'n', members: {} } },
  ] };
  const restarted = await fixture(left);
  expect((await restarted.call('/window')).body).toMatchObject({ window: { id: 'window' }, bots: { rank: 'm', members: {} } });
  expect((await restarted.call('')).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window']);
  expect((await restarted.call('/gone')).status).toBe(404);
  // The next write drops what was left.
  await restarted.call('/window/operations', 'POST', restarted.mutation('rename-window', 0, { type: 'rename', title: 'Renamed' }));
  expect(restarted.saved().workspaceWindows![0]!.bots).toEqual({ rank: 'm', members: {} });
});

it('keeps a section through layout edits and drops it with the group', async () => {
  const f = await fixture();
  const created = await f.call('', 'POST', { operationId: 'create-linked', issuedAt: Date.now(), window: sectionWindow('linked', 'writer'),
    bots: { rank: 'm', members: { writer: { label: 'Writer' } } } });
  expect(created.body.result.status).toBe('committed');
  const renamed = await f.call('/linked/operations', 'POST', f.mutation('rename-linked', 0, { type: 'rename', title: 'Renamed' }));
  expect(renamed.body).toMatchObject({ result: { status: 'committed' }, window: { title: 'Renamed' }, bots: { rank: 'm', members: { writer: { label: 'Writer' } } } });
  expect(f.saved().workspaceWindows![0]!.bots).toEqual({ rank: 'm', members: { writer: { label: 'Writer' } } });
  const deleted = await f.call('/linked', 'DELETE', f.mutation('delete-linked', 1, { type: 'delete' }));
  expect(deleted.body.result.status).toBe('committed');
  expect(deleted.body).not.toHaveProperty('bots');
  const row = f.saved().workspaceWindows![0]!;
  expect(row.deleted).toBe(true);
  expect(row).not.toHaveProperty('bots');
  expect(row).not.toHaveProperty('presentation');
  expect((await f.call()).body.groups).toEqual([]);
});

it('refuses to make a session a bot in a second section, naming the section that has it', async () => {
  const f = await fixture(); await f.create();
  expect((await f.call('/window/operations', 'POST', f.mutation('as-section', 0, { type: 'bots.add', rank: 'm' }))).body.result.status).toBe('committed');
  // A plain Window may still show the same session.
  const second = { ...sectionWindow('second', 'native', 'Second'), views: [createWindowView('writer', binding, 'primary')] };
  expect((await f.call('', 'POST', { operationId: 'second', issuedAt: Date.now(), window: second })).body.result.status).toBe('committed');
  const refused = await f.call('/second/operations', 'POST', f.mutation('second-as-section', 0, { type: 'bots.add', rank: 'n' }));
  expect(refused.body.result).toMatchObject({ status: 'rejected', code: 'bot_session_taken', message: 'This session is already a bot in "Window".' });
  expect(refused.body.bots).toBeUndefined();
  const created = await f.call('', 'POST', { operationId: 'third', issuedAt: Date.now(), window: { ...second, id: 'third' }, bots: { rank: 'o', members: {} } });
  expect(created.status).toBe(409);
  expect((await f.call()).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window', 'second']);
});

it('hides a group in Bot mode and shows it again, through storage restart, never hiding it in both modes', async () => {
  const f = await fixture(); await f.create();
  const hidden = await f.call('/window/operations', 'POST', f.mutation('hide-in-bots', 0, { type: 'bots.hide' }));
  expect(hidden.body).toMatchObject({ result: { status: 'committed', revision: 1 }, presentation: { bots: false } });
  const refused = await f.call('/window/operations', 'POST', f.mutation('hide-window-too', 1, { type: 'window.remove' }));
  expect(refused.body.result).toMatchObject({ status: 'rejected', code: 'last_appearance' });
  const restarted = await fixture(f.saved());
  expect((await restarted.call('/window')).body.presentation).toEqual({ bots: false });
  // Older pages read the Window list, which still includes a group shown as a Window.
  expect((await restarted.call('')).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window']);
  const shown = await restarted.call('/window/operations', 'POST', restarted.mutation('show-in-bots', 1, { type: 'bots.show' }));
  expect(shown.body.result.status).toBe('committed');
  expect(shown.body).not.toHaveProperty('presentation');
  expect(restarted.saved().workspaceWindows![0]).not.toHaveProperty('presentation');
});

it('counts a Side as a bot, so its session cannot be a bot in another section', async () => {
  const f = await fixture(); await f.create();
  expect((await f.call('/window/operations', 'POST', f.mutation('as-section', 0, { type: 'bots.add', rank: 'm' }))).body.result.status).toBe('committed');
  const other = { ...binding, nativeSessionId: 'other', title: 'Other' };
  const sided: WorkspaceWindow = { schemaVersion: 3, id: 'sided', title: 'Sided', revision: 0, selectedPrimaryViewId: 'lead', selectedViewId: 'lead',
    views: [createWindowView('lead', other, 'primary'), { ...createWindowView('side', binding, 'attached'), attachedTo: 'lead' }] };
  const created = await f.call('', 'POST', { operationId: 'sided', issuedAt: Date.now(), window: sided, bots: { rank: 'n', members: {} } });
  expect(created.status).toBe(409);
  expect(created.body).toEqual({ code: 'bot_session_taken', error: 'This session is already a bot in "Window".' });
  // Hidden in Bot mode, the same group holds no bots for the rule.
  const hiddenGroup = await f.call('', 'POST', { operationId: 'sided-hidden', issuedAt: Date.now(), window: sided, bots: { rank: 'n', members: {} }, presentation: { bots: false } });
  expect(hiddenGroup.body.result.status).toBe('committed');
});

it('keeps a bot on its conversation whichever client changes it', async () => {
  const f = await fixture(); await f.create();
  await f.call('/window/operations', 'POST', f.mutation('as-section', 0, { type: 'bots.add', rank: 'm' }));
  const rebind = await f.call('/window/operations', 'POST', f.mutation('rebind', 1, { type: 'view.bind', viewId: 'primary', binding: { ...binding, nativeSessionId: 'other' } }));
  expect(rebind.body.result).toMatchObject({ status: 'rejected', code: 'bot_view', revision: 1 });
  const retitle = await f.call('/window/operations', 'POST', f.mutation('retitle', 1, { type: 'view.bind', viewId: 'primary', binding: { ...binding, title: 'Renamed' } }));
  expect(retitle.body.result.status).toBe('committed');
  const details = await f.call('/window/operations', 'POST', f.mutation('label', 2, { type: 'bot.update', viewId: 'primary', details: { label: 'Writer', pinned: true } }));
  expect(details.body).toMatchObject({ result: { status: 'committed', revision: 3 }, bots: { members: { primary: { label: 'Writer', pinned: true } } } });
  // Layout errors keep their generic code.
  const missing = await f.call('/window/operations', 'POST', f.mutation('missing', 3, { type: 'view.close', viewId: 'nowhere' }));
  expect(missing.body.result).toMatchObject({ status: 'rejected', code: 'invalid_operation' });
});

it('lets other edits through when an older Worker left a session as a bot twice', async () => {
  const f = await fixture(); await f.create();
  const saved = structuredClone(f.saved());
  const subject = saved.workspaceWindows![0]!.subject;
  const twin = (id: string, title: string) => ({ subject, id, window: sectionWindow(id, 'twin', title), bots: { rank: 'm', members: {} }, generation: 0, receipts: [] });
  const restarted = await fixture({ ...saved, workspaceWindows: [...saved.workspaceWindows!, twin('one', 'One'), twin('two', 'Two')] });
  expect((await restarted.call('/window/operations', 'POST', restarted.mutation('elsewhere', 0, { type: 'bots.add', rank: 'o' }))).body.result.status).toBe('committed');
  const renamed = await restarted.call('/one/operations', 'POST', restarted.mutation('rename-one', 0, { type: 'rename', title: 'Renamed' }));
  expect(renamed.body.result).toMatchObject({ status: 'rejected', code: 'bot_session_taken', message: 'This session is already a bot in "Two".' });
  expect((await restarted.call('/one/operations', 'POST', restarted.mutation('unsection-one', 0, { type: 'bots.remove' }))).body.result.status).toBe('committed');
});

it('checks bots only among one user\'s groups', async () => {
  const f = await fixture(); await f.create();
  const saved = structuredClone(f.saved());
  const others = { subject: 'someone-else', id: 'theirs', window: sectionWindow('theirs', 'native', 'Theirs'), bots: { rank: 'm', members: {} }, generation: 0, receipts: [] };
  const restarted = await fixture({ ...saved, workspaceWindows: [...saved.workspaceWindows!, others] });
  expect((await restarted.call('/window/operations', 'POST', restarted.mutation('mine', 0, { type: 'bots.add', rank: 'n' }))).body.result.status).toBe('committed');
});

it('merges, separates and moves bots between groups in one step each, with a receipt on every group', async () => {
  const f = await fixture(); await f.create();
  await f.call('', 'POST', { operationId: 'create-section', issuedAt: Date.now(), window: sectionWindow('section', 'writer'), bots: { rank: 'm', members: {} }, presentation: { window: false } });
  const merge = { operationId: 'merge', issuedAt: Date.now(), baseRevision: 0, source: 'window', sourceRevision: 0 };
  const merged = await f.call('/section/merge', 'POST', merge);
  expect(merged.body.result.status).toBe('committed');
  expect(merged.body.groups.window).toBeNull();
  expect(merged.body.groups.section).toMatchObject({ window: { revision: 1, views: [{ id: 'writer' }, { id: 'primary' }] }, bots: { rank: 'm' } });
  expect(merged.body.groups.section.presentation).toBeUndefined();
  // The same request is answered from its receipt, found on either group.
  expect((await f.call('/section/merge', 'POST', merge)).body.result).toEqual(merged.body.result);
  expect((await f.call('/window/operations/merge')).body.result).toEqual(merged.body.result);
  // A group named twice gets one receipt.
  const itself = await f.call('/section/merge', 'POST', { operationId: 'itself', issuedAt: Date.now(), baseRevision: 1, source: 'section', sourceRevision: 1 });
  expect(itself.body.result).toMatchObject({ status: 'rejected', code: 'same_group' });

  const split = await f.call('/section/split', 'POST', { operationId: 'split', issuedAt: Date.now(), baseRevision: 1, newId: 'section-bots' });
  expect(split.body.groups.section.bots).toBeUndefined();
  expect(split.body.groups['section-bots']).toMatchObject({ presentation: { window: false }, window: { revision: 0 } });
  const onto = await f.call('/section/split', 'POST', { operationId: 'onto', issuedAt: Date.now(), baseRevision: 2, newId: 'section' });
  expect(onto.body.result).toMatchObject({ status: 'rejected', code: 'window_exists' });

  await f.call('', 'POST', { operationId: 'create-third', issuedAt: Date.now(), bots: { rank: 'n', members: {} }, presentation: { window: false },
    window: { schemaVersion: 3, id: 'third', title: 'Third', revision: 0, selectedPrimaryViewId: null, selectedViewId: null, views: [] } });
  const transfer = await f.call('/section-bots/transfer', 'POST', { operationId: 'transfer', issuedAt: Date.now(), baseRevision: 0, viewId: 'primary', target: 'third', targetRevision: 0 });
  expect(transfer.body.groups['section-bots'].window.views.map((view: { id: string }) => view.id)).toEqual(['writer']);
  expect(transfer.body.groups.third.window.views.map((view: { id: string }) => view.id)).toEqual(['primary']);

  const stale = await f.call('/section/split', 'POST', { operationId: 'stale', issuedAt: Date.now(), baseRevision: 0, newId: 'again' });
  expect(stale.body.result).toMatchObject({ status: 'rejected', code: 'revision_conflict' });
  expect(stale.body.groups.again).toBeUndefined();

  // The stored state, receipts included, is still valid.
  const restarted = await fixture(f.saved());
  expect((await restarted.call()).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['section', 'section-bots', 'third']);
});

it('refuses cross-group operations without changing any group', async () => {
  const f = await fixture(); await f.create();
  await f.call('', 'POST', { operationId: 'create-section', issuedAt: Date.now(), window: sectionWindow('section', 'writer'), bots: { rank: 'm', members: {} }, presentation: { window: false } });
  await f.call('', 'POST', { operationId: 'create-other', issuedAt: Date.now(), window: sectionWindow('other', 'native', 'Other'), bots: { rank: 'n', members: {} }, presentation: { window: false } });

  // The merged section would hold a session that is already a bot in another section.
  const clash = { operationId: 'clash', issuedAt: Date.now(), baseRevision: 0, source: 'window', sourceRevision: 0 };
  const refused = await f.call('/section/merge', 'POST', clash);
  expect(refused.body.result).toMatchObject({ status: 'rejected', code: 'bot_session_taken', message: 'This session is already a bot in "Other".' });
  expect(refused.body.groups.window.window.revision).toBe(0);
  expect(refused.body.groups.section.window.views.map((view: { id: string }) => view.id)).toEqual(['writer']);
  expect((await f.call('/window/operations/clash')).body.result).toEqual(refused.body.result);
  expect((await f.call('/section/operations/clash')).body.result).toEqual(refused.body.result);

  // A receipt answers only the request it was written for.
  const misaddressed = await f.call('/other/merge', 'POST', clash);
  expect(misaddressed.status).toBe(409);
  expect(misaddressed.body.code).toBe('operation_conflict');

  // A group that does not exist leaves no receipt.
  const unknown = await f.call('/section/merge', 'POST', { operationId: 'unknown', issuedAt: Date.now(), baseRevision: 0, source: 'nowhere', sourceRevision: 0 });
  expect(unknown.status).toBe(404);
  expect(unknown.body.code).toBe('window_not_found');
  expect((await f.call('/section/operations/unknown')).status).toBe(404);

  // A deleted group keeps its identity, so a split cannot reuse it.
  expect((await f.call('/other', 'DELETE', f.mutation('delete-other', 0, { type: 'delete' }))).body.result.status).toBe('committed');
  const onto = await f.call('/section/split', 'POST', { operationId: 'onto-deleted', issuedAt: Date.now(), baseRevision: 0, newId: 'other' });
  expect(onto.body.result).toMatchObject({ status: 'rejected', code: 'window_exists' });

  // The stored state, rejected receipts included, is still valid.
  const restarted = await fixture(f.saved());
  expect((await restarted.call()).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window', 'section']);
});
