import { createInterface } from 'node:readline';
import { createHostExecutionPolicy, protectHostDirectory } from './execution-policy.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCodexSessionDirectory } from './directory.js';
import { CodexAppServerProvider } from '../../agent-provider-codex/src/provider.js';
import { createScriptedAppServer } from '../../agent-provider-codex/src/test-utils/scripted-app-server.js';
import { SessionReferenceStore, sourceSessionExtensions } from './session-reference.js';

it('binds reads to the granted source and rejects unbounded or alternate source inputs', async () => {
  const calls: unknown[] = [];
  const tools = sourceSessionExtensions('source', async (id, query) => { calls.push({ id, query }); return { entries: [] }; }).tools!;
  expect(JSON.parse(await tools[0]!.execute({ limit: 2 }))).toMatchObject({ sourceSessionId: 'source', entries: [] });
  expect(calls).toEqual([{ id: 'source', query: { limit: 2 } }]);
  for (const args of [{ sessionId: 'other' }, { limit: 100000 }, { textOffset: -1 }, { query: '' }, { turnId: 't', query: 'x' }]) {
    await expect(tools[0]!.execute(args)).rejects.toThrow();
  }
});

it('persists the grant and restores tools and instructions after directory recreation without reading source history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'side-reference-'));
  const natives: ReturnType<typeof createScriptedAppServer>[] = [];
  const makeProvider = () => new CodexAppServerProvider({ spawn: () => {
    const native = createScriptedAppServer({ 'thread/start': () => ({ thread: { id: 'side' } }),
      'thread/resume': () => ({ thread: { id: 'side' } }), 'thread/read': () => ({ thread: { id: 'side', turns: [] } }) });
    natives.push(native); return native.child;
  } });
  let directory = createCodexSessionDirectory(makeProvider(), [], new SessionReferenceStore(root));
  try {
    expect(await directory.create({ sourceNativeSessionId: 'source' })).toBe('side');
    const start = natives[0]!.requests.find(request => request.method === 'thread/start')!;
    expect(start.params).toMatchObject({ dynamicTools: [{ name: 'read_source_session' }], developerInstructions: expect.stringContaining('source') });
    expect(natives[0]!.requests.some(request => request.method === 'thread/read' || request.method === 'thread/items/list')).toBe(false);
    await directory.close();
    directory = createCodexSessionDirectory(makeProvider(), [], new SessionReferenceStore(root));
    const restored = await directory.open('side');
    expect((await restored.runtimeInfo()).sessionId).toBe('side');
    expect(natives[1]!.requests.find(request => request.method === 'thread/resume')?.params).toMatchObject({ developerInstructions: expect.stringContaining('read_source_session') });
    expect(await new SessionReferenceStore(root).get('side')).toMatchObject({ sourceNativeSessionId: 'source', handle: { sessionId: 'side' } });
  } finally { await directory.close(); await rm(root, { recursive: true, force: true }); }
});


it('rechecks source workspace on every tool call, including native child sources outside root listings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-policy-'));
  let sourceWorkspace = root;
  const native = createScriptedAppServer({ 'thread/start': () => ({ thread: { id: 'side' } }),
    'thread/items/list': () => ({ data: [] }) });
  const provider = new CodexAppServerProvider({ spawn: () => native.child });
  // A native child can be inspected by identity without appearing in the root catalog.
  provider.readSessionWorkspace = async () => sourceWorkspace;
  const directory = protectHostDirectory(createCodexSessionDirectory(provider, [], new SessionReferenceStore(root)),
    (await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: root }))!);
  const lines = createInterface({ input: native.child.stdin });
  try {
    await directory.create({ cwd: root, sourceNativeSessionId: 'native-child' });
    sourceWorkspace = tmpdir();
    const response = new Promise<any>(resolve => lines.on('line', line => { const value = JSON.parse(line); if (value.id === 'denied') resolve(value); }));
    native.child.stdout.write(JSON.stringify({ id: 'denied', method: 'item/tool/call', params: { threadId: 'side', turnId: 't', callId: 'c', tool: 'read_source_session', arguments: {} } }) + '\n');
    expect((await response).result).toMatchObject({ success: false, contentItems: [{ text: expect.stringMatching(/outside.*allowed/i) }] });
    expect(native.requests.some(request => request.method === 'thread/items/list')).toBe(false);
  } finally { lines.close(); await directory.close(); await rm(root, { recursive: true, force: true }); }
});

it('restores idle source sessions with native saved settings and the granted source tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idle-reference-'));
  const natives: ReturnType<typeof createScriptedAppServer>[] = [];
  const provider = new CodexAppServerProvider({ spawn: () => {
    const native = createScriptedAppServer({ 'thread/start': () => ({ thread: { id: 'side' }, cwd: '/old', model: 'old-model' }),
      'thread/resume': () => ({ thread: { id: 'side' }, cwd: '/new', model: 'new-model' }),
      'thread/read': () => ({ thread: { id: 'side', turns: [] } }) });
    natives.push(native); return native.child;
  } });
  const directory = createCodexSessionDirectory(provider, [], new SessionReferenceStore(root));
  try {
    await directory.create({ cwd: '/old', model: 'old-model', sourceNativeSessionId: 'source' });
    await (await directory.open('side')).dispose();
    await directory.sessionReleased!('side');
    const restored = await directory.open('side');
    const request = natives[1]!.requests.find(request => request.method === 'thread/resume')!.params as Record<string, unknown>;
    expect(request.cwd).toBeUndefined(); expect(request.model).toBeUndefined();
    expect(request.developerInstructions).toContain('read_source_session');
    expect(await restored.runtimeInfo()).toMatchObject({ sessionId: 'side', cwd: '/new', model: 'new-model' });
  } finally { await directory.close(); await rm(root, { recursive: true, force: true }); }
});

it('uses a newly installed binding reader in an already-open native source tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-live-binding-'));
  const native = createScriptedAppServer({ 'thread/start': () => ({ thread: { id: 'ask' } }), 'thread/items/list': () => ({ data: [] }) });
  const history = createScriptedAppServer({ 'thread/items/list': () => ({ data: [] }) });
  let spawns = 0;
  const provider = new CodexAppServerProvider({ spawn: () => spawns++ === 0 ? native.child : history.child });
  const directory = createCodexSessionDirectory(provider, [], new SessionReferenceStore(root));
  const lines = createInterface({ input: native.child.stdin });
  try {
    await directory.create({ sourceNativeSessionId: 'A' });
    directory.setSourceBindingReader!(async (reader, original, query, read) => {
      if (reader !== 'ask' || original !== 'A') throw new Error('Wrong source binding identity');
      return { ...await read('B', query), sourceSessionId: 'B', sourceRoleId: 'role', sourceRoleRevision: 2 };
    });
    const response = new Promise<any>(resolve => lines.on('line', line => { const value = JSON.parse(line); if (value.id === 'read-after-handoff') resolve(value); }));
    native.child.stdout.write(JSON.stringify({ id: 'read-after-handoff', method: 'item/tool/call', params: {
      threadId: 'ask', turnId: 't', callId: 'call', tool: 'read_source_session', arguments: {},
    } }) + '\n');
    const result = (await response).result;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ sourceSessionId: 'B', sourceRoleId: 'role', sourceRoleRevision: 2 });
    expect(history.requests.find(request => request.method === 'thread/items/list')?.params).toMatchObject({ threadId: 'B' });
    expect(await directory.sourceReferences!()).toMatchObject([{ nativeSessionId: 'ask', sourceNativeSessionId: 'A' }]);
  } finally { lines.close(); await directory.close(); await rm(root, { recursive: true, force: true }); }
});
