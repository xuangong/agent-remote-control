import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentOperationRejectedError, type AgentSession, type AgentSessionConfig, type AgentSessionExtensions, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { createManagedStdioDirectory, type ManagedStdioProvider } from './stdio-directory.js';
import { SessionReferenceStore } from './session-reference.js';
import { acquireNativeSession, inspectNativeOwner } from './native-session-owner.js';

const userTool: AgentSessionTool = { name: 'user_tool', description: 'User tool', inputSchema: { type: 'object' }, execute: async () => 'user result' };
function barrier() {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  return { release, async entered() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Validation stage was not entered')), 1000); })]); }
    finally { clearTimeout(timer); }
  }, async hold() { enter(); await wait; } };
}
const fixture = () => {
  const configurations: AgentSessionExtensions[] = [], handles: string[] = [], reads: string[] = [];
  let startRead: string | undefined, returnedId = 'reader', savedModel = 'native-model';
  const native = (id: string): AgentSession => {
    let closed = false;
    return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
      async *observe() { yield { type: 'history_boundary' }; }, async runtimeInfo() { return { providerId: 'claude', sessionId: id, status: closed ? 'closed' : 'idle', model: savedModel,
        persistence: { providerId: 'claude', sessionId: id, opaque: JSON.stringify({ model: savedModel }) } }; },
      async sendMessage() {}, async sendMessageContent() {}, async respondToInteraction() {}, async dispose() { closed = true; } };
  };
  const provider: ManagedStdioProvider = { listSessions: async () => [],
    async createSession(config: AgentSessionConfig) {
      configurations.push(config);
      try { await config.tools?.find(tool => tool.name === 'read_source_session')?.execute({}); } catch (error) { startRead = String(error); }
      return native(returnedId);
    }, async resumeSession(handle, extensions) { handles.push(handle.opaque); configurations.push(extensions ?? {}); return native(returnedId); },
    async readSessionHistory(id) { reads.push(id); return { entries: [{ id: 'row', turnId: '', role: 'user', text: `history ${id}`, textOffset: 0, totalChars: 9 }] }; },
  };
  return { provider, configurations, handles, reads, startRead: () => startRead, setId: (id: string) => { returnedId = id; }, setModel: (model: string) => { savedModel = model; } };
};

it('keeps grant and disposal failure causes after admitted stdio creation and disables the unconfirmed reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stdio-grant-disposal-')), f = fixture();
  const grantFailure = new AgentOperationRejectedError('operation_rejected', 'grant write refused'), disposalFailure = new Error('native control disposal uncertain');
  const store = new SessionReferenceStore(root, 'claude'); store.set = async () => { throw grantFailure; };
  const create = f.provider.createSession.bind(f.provider); let canExit = false, completed = 0;
  const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async createSession(config) {
    const session = await create(config), dispose = session.dispose.bind(session);
    session.dispose = async () => { if (!canExit) throw disposalFailure; await dispose(); }; return session;
  } }, [], undefined, store);
  try {
    const failure = await directory.create({ sourceNativeSessionId: 'A' }, { completed() { completed++; } }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure).not.toBeInstanceOf(AgentOperationRejectedError);
    expect(failure.errors).toEqual([grantFailure, disposalFailure]); expect(completed).toBe(1); expect(f.configurations).toHaveLength(1);
    await expect(f.configurations[0]!.tools![0]!.execute({})).rejects.toThrow(/identity.*ready|unavailable/i);
  } finally { canExit = true; await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('composes user tools and instructions, dynamically routes source reads, and restores durable grants on cold open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-source-')); const f = fixture();
  const store = new SessionReferenceStore(root, 'claude');
  let directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, store);
  try {
    expect(directory.supportsSourceReferences).toBe(true);
    const id = await directory.create({ sourceNativeSessionId: 'A', instructions: 'User instructions', systemPrompt: 'User native base', tools: [userTool] });
    expect(id).toBe('reader'); expect(f.startRead()).toMatch(/identity.*ready/i); expect(f.reads).toEqual([]);
    const config = f.configurations[0]!;
    expect(config.systemPrompt).toBe('User native base'); expect(config.instructions).toContain('User instructions');
    expect(config.instructions).toContain('quoted background');
    expect(config.tools!.map(tool => tool.name)).toEqual(['user_tool', 'read_source_session']);
    expect(await config.tools![0]!.execute({})).toBe('user result');
    const read = config.tools!.find(tool => tool.name === 'read_source_session')!;
    expect(JSON.parse(await read.execute({}))).toMatchObject({ sourceSessionId: 'A' });
    directory.setSourceBindingReader!(async (reader, original, query, history) => {
      if (reader !== 'reader' || original !== 'A') throw new Error('Wrong identity');
      return { ...await history('B', query), sourceSessionId: 'B', sourceRoleRevision: 2 };
    });
    expect(JSON.parse(await read.execute({}))).toMatchObject({ sourceSessionId: 'B', sourceRoleRevision: 2 });
    directory.setSourceBindingReader!(async () => { throw new Error('Pending relation gate'); });
    await expect(read.execute({})).rejects.toThrow(/Pending relation/);
    expect(f.reads).toEqual(['A', 'B']);
    expect(directory.requiresController!(id)).toBe(true);
    expect(await directory.sourceReferences!()).toEqual([{ nativeSessionId: 'reader', sourceNativeSessionId: 'A' }]);
    await directory.close(); await expect(read.execute({})).rejects.toThrow(/closed/i);
    f.setModel('changed-native-model');
    directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, new SessionReferenceStore(root, 'claude'));
    const reopened = await directory.open('reader', { extensions: { instructions: 'TPM instructions', tools: [userTool] } });
    expect((await reopened.runtimeInfo()).model).toBe('changed-native-model'); expect(f.handles).toEqual(['{}']);
    const recovered = f.configurations.at(-1)!;
    expect(recovered.instructions).toContain('User instructions'); expect(recovered.instructions).toContain('TPM instructions');
    expect(recovered.systemPrompt).toBe('User native base'); expect(recovered.tools!.map(tool => tool.name)).toEqual(['user_tool', 'read_source_session']);
    expect(JSON.parse(await recovered.tools!.find(tool => tool.name === 'read_source_session')!.execute({}))).toMatchObject({ sourceSessionId: 'A' });
    await expect(read.execute({})).rejects.toThrow(/closed|ready/i);
  } finally { await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('fences source callbacks during managed shutdown and retains a failed grant-cleanup lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-grant-cleanup-')); const f = fixture();
  const references = new SessionReferenceStore(join(root, 'references'), 'claude');
  references.set = async () => { throw new Error('Grant write failed'); };
  let canExit = false; let captured: AgentSession | undefined;
  const create = f.provider.createSession.bind(f.provider);
  const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async createSession(config) {
    const session = await create(config); const dispose = session.dispose.bind(session); captured = session;
    session.dispose = async () => { if (!canExit) throw new Error('Native exit unconfirmed'); await dispose(); }; return session;
  } }, [], { root: join(root, 'owners') }, references);
  try {
    const failure = await directory.create({ sourceNativeSessionId: 'A' }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors[0].message).toMatch(/grant/i); expect(failure.errors[1].message).toMatch(/unconfirmed/);
    const key = { root: join(root, 'owners'), providerId: 'claude', sessionId: 'reader' };
    expect(await inspectNativeOwner(key)).toMatchObject({ kind: 'controller' });
    await expect(acquireNativeSession({ ...key, kind: 'native_cli' })).rejects.toMatchObject({ code: 'native_session_owned' });
    await expect(f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!.execute({})).rejects.toThrow(/closed|ready/i);
    canExit = true; await directory.close(); expect(await inspectNativeOwner(key)).toBeUndefined();
  } finally { canExit = true; await captured?.dispose(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('rejects source creation without both history and storage and enforces per-read access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-access-')); const f = fixture();
  const noStore = createManagedStdioDirectory('claude', 'Claude', f.provider, []);
  const noHistory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, readSessionHistory: undefined }, [], undefined, new SessionReferenceStore(root, 'claude'));
  const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, new SessionReferenceStore(root, 'claude'));
  try {
    expect(noStore.supportsSourceReferences).toBe(false); expect(noHistory.supportsSourceReferences).toBe(false);
    await expect(noStore.create({ sourceNativeSessionId: 'A' })).rejects.toThrow(/unavailable/);
    await expect(noHistory.create({ sourceNativeSessionId: 'A' })).rejects.toThrow(/unavailable/);
    await directory.create({ sourceNativeSessionId: 'A' });
    const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
    directory.setSourceAccessCheck!(async () => { throw new Error('Access denied'); });
    await expect(read.execute({})).rejects.toThrow(/denied/); expect(f.reads).toEqual([]);
    await expect(noHistory.open('reader')).rejects.toThrow(/history.*unavailable/i);
  } finally { await Promise.all([directory.close(), noHistory.close(), noStore.close()]); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('rejects conflicting tool names and verifies synthesized extensions for cached and concurrent opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-extensions-')); const f = fixture();
  const store = new SessionReferenceStore(root, 'claude');
  let directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, store);
  try {
    await expect(directory.create({ sourceNativeSessionId: 'A', tools: [{ ...userTool, name: 'read_source_session' }] })).rejects.toThrow(/duplicate|conflict/i);
    await directory.create({ sourceNativeSessionId: 'A', instructions: 'same', tools: [userTool] });
    const cached = await directory.open('reader', { extensions: { instructions: 'same', tools: [userTool] } });
    expect(await directory.open('reader', { extensions: { instructions: 'same', tools: [userTool] } })).toBe(cached);
    await expect(directory.open('reader', { extensions: { instructions: 'different', tools: [userTool] } })).rejects.toThrow(/extensions differ/i);
    await directory.close();
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const resume = f.provider.resumeSession.bind(f.provider); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async resumeSession(handle, extensions) { started(); await gate; return resume(handle, extensions); } }, [], undefined, store);
    const one = directory.open('reader', { extensions: { instructions: 'same', tools: [userTool] } }); await ready;
    const two = directory.open('reader', { extensions: { instructions: 'same', tools: [userTool] } });
    const bad = directory.open('reader', { extensions: { instructions: 'different', tools: [userTool] } });
    const rejected = expect(bad).rejects.toThrow(/extensions differ/i);
    finish(); const session = await one; expect(await two).toBe(session); await rejected;
  } finally { await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('rejects mismatched cold native identity and disables source callbacks if durable grant persistence fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-identity-')); const f = fixture();
  const store = new SessionReferenceStore(root, 'claude'); await store.set({ sourceNativeSessionId: 'A', systemPrompt: 'Source', handle: { providerId: 'claude', sessionId: 'expected', opaque: '{}' } });
  const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, store);
  try {
    await expect(directory.open('expected')).rejects.toThrow(/identity/i);
    await expect(f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!.execute({})).rejects.toThrow(/identity|closed|ready/i);
    store.set = async () => { throw new Error('Store write failed'); };
    await expect(directory.create({ sourceNativeSessionId: 'A' })).rejects.toThrow(/Store write failed/);
    await expect(f.configurations.at(-1)!.tools!.find(tool => tool.name === 'read_source_session')!.execute({})).rejects.toThrow(/closed|ready/i);
    expect(f.reads).toEqual([]);
  } finally { await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('does not revive an obsolete source callback when the same directory reopens the native reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-obsolete-')); const f = fixture();
  const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, new SessionReferenceStore(root, 'claude'));
  try {
    await directory.create({ sourceNativeSessionId: 'A' });
    const oldRead = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
    await (await directory.open('reader')).dispose();
    await directory.open('reader');
    await expect(oldRead.execute({})).rejects.toThrow(/closed|ready|obsolete/i);
    expect(JSON.parse(await f.configurations.at(-1)!.tools!.find(tool => tool.name === 'read_source_session')!.execute({}))).toMatchObject({ sourceSessionId: 'A' });
    expect(f.reads).toEqual(['A']);
  } finally { await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it.each([false, true])('rejects source tool callbacks while native shutdown is pending (managed ownership: %s)', async owned => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-source-shutdown-')); const f = fixture();
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const create = f.provider.createSession.bind(f.provider);
  const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async createSession(config) {
    const session = await create(config); session.dispose = async () => { await gate; }; return session;
  } }, [], owned ? { root: join(root, 'owners') } : undefined, new SessionReferenceStore(join(root, 'references'), 'claude'));
  try {
    await directory.create({ sourceNativeSessionId: 'A' });
    const closing = (await directory.open('reader')).dispose();
    const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
    try { await expect(read.execute({})).rejects.toThrow(/closed|control|ownership/i); expect(f.reads).toEqual([]); }
    finally { finish(); await closing; }
  } finally { finish(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('validates ordinary cold-open tools before creating a runtime', async () => {
  const f = fixture(); const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, []);
  try {
    await expect(directory.open('reader', { extensions: { tools: [userTool, userTool] } })).rejects.toThrow(/duplicate|conflict/i);
    expect(f.configurations).toEqual([]);
  } finally { await directory.close(); }
}, 10000);

it('rejects source creation when the directory closes during the durable grant write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-grant-close-')); const f = fixture();
  const store = new SessionReferenceStore(root, 'claude'); const write = store.set.bind(store);
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  store.set = async grant => { started(); await gate; await write(grant); };
  const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, store);
  const creating = directory.create({ sourceNativeSessionId: 'A' });
  const rejected = expect(creating).rejects.toThrow(/directory.*closed/i);
  try {
    await ready; await directory.close(); finish(); await rejected;
    await expect(f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!.execute({})).rejects.toThrow(/closed/i);
    expect(f.reads).toEqual([]);
  } finally { finish(); await creating.catch(() => undefined); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('restores explicit empty and omitted base prompts distinctly and rejects conflicting persisted prompts', async () => {
  for (const systemPrompt of ['', undefined]) {
    const root = await mkdtemp(join(tmpdir(), 'arc-stdio-empty-prompt-')); const f = fixture();
    const store = new SessionReferenceStore(root, 'claude');
    let directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, store);
    try {
      await directory.create({ sourceNativeSessionId: 'A', ...(systemPrompt !== undefined ? { systemPrompt } : {}) });
      await directory.close(); directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, store);
      if (systemPrompt === '') await expect(directory.open('reader', { extensions: { systemPrompt: 'Conflicting base' } })).rejects.toThrow(/conflicting.*prompt/i);
      await directory.open('reader'); expect(f.configurations.at(-1)!.systemPrompt).toBe(systemPrompt);
    } finally { await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
}, 10000);

it('retains rejected native identities for cleanup when their first disposal fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-rejected-identity-')); const f = fixture();
  let canExit = false;
  const resume = f.provider.resumeSession.bind(f.provider);
  const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async resumeSession(handle, extensions) {
    const session = await resume(handle, extensions); const dispose = session.dispose.bind(session);
    session.dispose = async () => { if (!canExit) throw new Error('Native identity exit unconfirmed'); await dispose(); }; return session;
  } }, [], { root });
  const key = { root, providerId: 'claude', sessionId: 'expected' };
  try {
    await expect(directory.open('expected')).rejects.toThrow(/unconfirmed|cleanup/i);
    expect(await inspectNativeOwner(key)).toMatchObject({ kind: 'controller' });
    canExit = true; await directory.close(); expect(await inspectNativeOwner(key)).toBeUndefined();
  } finally { canExit = true; await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it('validates source prompt presence metadata while preserving legacy grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-prompt-presence-'));
  const store = new SessionReferenceStore(root, 'claude');
  const grant = { sourceNativeSessionId: 'A', systemPrompt: '', handle: { providerId: 'claude', sessionId: 'reader', opaque: '{}' } };
  try {
    await store.set(grant); expect(await store.get('reader')).toEqual(grant);
    await expect(store.set({ ...grant, systemPromptProvided: false, systemPrompt: 'inconsistent' })).rejects.toThrow(/presence/i);
    await expect(store.set({ ...grant, systemPromptProvided: 'invalid' as unknown as boolean })).rejects.toThrow(/presence/i);
    const path = join(root, `${createHash('sha256').update('reader').digest('hex')}.json`);
    for (const invalid of [{ systemPromptProvided: 'invalid' }, { systemPromptProvided: false, systemPrompt: 'inconsistent' }]) {
      await writeFile(path, JSON.stringify({ ...grant, ...invalid }));
      await expect(store.get('reader')).rejects.toThrow(/invalid/i);
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

it.each(['runtime provider', 'persistence provider', 'persistence session'] as const)('rejects mismatched %s before source routing', async field => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-native-identity-')); const f = fixture();
  const create = f.provider.createSession.bind(f.provider);
  const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async createSession(config) {
    const session = await create(config); const runtime = session.runtimeInfo.bind(session);
    session.runtimeInfo = async () => {
      const info = await runtime();
      return { ...info, ...(field === 'runtime provider' ? { providerId: 'copilot' } : {}), persistence: { ...info.persistence!,
        ...(field === 'persistence provider' ? { providerId: 'copilot' } : {}), ...(field === 'persistence session' ? { sessionId: 'other' } : {}) } };
    }; return session;
  } }, [], undefined, new SessionReferenceStore(root, 'claude'));
  try {
    await expect(directory.create({ sourceNativeSessionId: 'A' })).rejects.toThrow(/identity/i);
    await expect(f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!.execute({})).rejects.toThrow(/identity|ready|closed/i);
    expect(f.reads).toEqual([]);
  } finally { await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

const heldReadCases = ['dispose', 'reopen', 'transfer', 'revoke', 'close'] as const;
for (const routed of [false, true]) {
  it.each(heldReadCases)(`rejects held ${routed ? 'routed' : 'local'} source content after %s`, async change => {
    const root = await mkdtemp(join(tmpdir(), 'arc-stdio-held-read-')); const f = fixture(); const io = barrier();
    const history = f.provider.readSessionHistory!.bind(f.provider);
    const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider,
      async readSessionHistory(id, query) { await io.hold(); return history(id, query); }, releaseSession: async () => {} },
      [], { root: join(root, 'owners') }, new SessionReferenceStore(join(root, 'references'), 'claude'));
    let cli: Awaited<ReturnType<typeof acquireNativeSession>> | undefined;
    let allowed = true, checks = 0, routes = 0;
    directory.setSourceAccessCheck!(async () => { checks++; if (!allowed) throw new Error('Current source access revoked'); });
    if (routed) directory.setSourceBindingReader!(async (_reader, _source, query, read) => {
      routes++; return { ...await read('B', query), sourceSessionId: 'B' };
    });
    try {
      await directory.create({ sourceNativeSessionId: 'A' });
      const session = await directory.open('reader');
      const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
      const pending = read.execute({}); const rejected = expect(pending).rejects.toThrow(/closed|control|obsolete|ready|revoked/i);
      await io.entered();
      if (change === 'dispose' || change === 'reopen') { await session.dispose(); if (change === 'reopen') await directory.open('reader'); }
      else if (change === 'transfer') {
        const key = { root: join(root, 'owners'), providerId: 'claude', sessionId: 'reader' };
        const owner = await inspectNativeOwner(key); cli = await acquireNativeSession({ ...key, kind: 'native_cli', takeOver: owner!.generation });
        cli.activate(async () => 'requested');
      } else if (change === 'revoke') allowed = false;
      else await directory.close();
      io.release(); await rejected;
      expect(f.reads).toEqual([routed ? 'B' : 'A']); expect(routes).toBe(routed ? 1 : 0);
      if (change === 'revoke') expect(checks).toBe(2);
    } finally { io.release(); await cli?.release(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }, 10000);

  it.each(['dispose', 'replace access check'] as const)(`rejects held ${routed ? 'routed' : 'local'} source content when post-read access validation awaits %s`, async change => {
    const root = await mkdtemp(join(tmpdir(), 'arc-stdio-held-access-')); const f = fixture(); const check = barrier();
    const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, new SessionReferenceStore(root, 'claude'));
    let checks = 0;
    directory.setSourceAccessCheck!(async () => { if (++checks === 2) await check.hold(); });
    if (routed) directory.setSourceBindingReader!(async (_reader, _source, query, read) => ({ ...await read('B', query), sourceSessionId: 'B' }));
    try {
      await directory.create({ sourceNativeSessionId: 'A' });
      const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
      const pending = read.execute({}); const rejected = expect(pending).rejects.toThrow(/closed|control|changed|obsolete|ready/i);
      await check.entered();
      if (change === 'dispose') await (await directory.open('reader')).dispose();
      else directory.setSourceAccessCheck!(async () => { throw new Error('Replacement source policy'); });
      check.release(); await rejected; expect(f.reads).toEqual([routed ? 'B' : 'A']);
    } finally { check.release(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }, 10000);

  it.each(['dispose', 'runtime identity', 'revoke'] as const)(`rejects held ${routed ? 'routed' : 'local'} source content when final runtime validation awaits %s`, async change => {
    const root = await mkdtemp(join(tmpdir(), 'arc-stdio-held-runtime-')); const f = fixture(); const runtime = barrier();
    let held = false, mismatched = false, allowed = true;
    const create = f.provider.createSession.bind(f.provider);
    const history = f.provider.readSessionHistory!.bind(f.provider);
    const directory = createManagedStdioDirectory('claude', 'Claude', { ...f.provider, async createSession(config) {
      const session = await create(config); const info = session.runtimeInfo.bind(session);
      session.runtimeInfo = async () => {
        const snapshot = await info(); if (held) await runtime.hold();
        return { ...snapshot, ...(mismatched ? { providerId: 'copilot' } : {}) };
      }; return session;
    }, async readSessionHistory(id, query) { const page = await history(id, query); held = true; return page; } }, [], undefined, new SessionReferenceStore(root, 'claude'));
    directory.setSourceAccessCheck!(async () => { if (!allowed) throw new Error('Source access revoked'); });
    if (routed) directory.setSourceBindingReader!(async (_reader, _source, query, read) => ({ ...await read('B', query), sourceSessionId: 'B' }));
    try {
      await directory.create({ sourceNativeSessionId: 'A' });
      const session = await directory.open('reader'); const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
      const pending = read.execute({}); const rejected = expect(pending).rejects.toThrow(/closed|control|identity|obsolete|ready|revoked/i);
      await runtime.entered();
      if (change === 'dispose') { const disposing = session.dispose(); held = false; runtime.release(); await disposing; }
      else { if (change === 'runtime identity') mismatched = true; else allowed = false; runtime.release(); }
      await rejected;
    } finally { held = false; runtime.release(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }, 10000);

  it.each(['dispose', 'replace access check', 'close'] as const)(`rejects held ${routed ? 'routed' : 'local'} source content when final access validation awaits %s`, async change => {
    const root = await mkdtemp(join(tmpdir(), 'arc-stdio-final-access-')); const f = fixture(); const check = barrier();
    const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, new SessionReferenceStore(root, 'claude'));
    let checks = 0;
    directory.setSourceAccessCheck!(async () => { if (++checks === 3) await check.hold(); });
    if (routed) directory.setSourceBindingReader!(async (_reader, _source, query, read) => ({ ...await read('B', query), sourceSessionId: 'B' }));
    try {
      await directory.create({ sourceNativeSessionId: 'A' });
      const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
      const pending = read.execute({}); const rejected = expect(pending).rejects.toThrow(/closed|control|changed|obsolete|ready/i);
      await check.entered();
      if (change === 'dispose') await (await directory.open('reader')).dispose();
      else if (change === 'close') await directory.close();
      else directory.setSourceAccessCheck!(async () => { throw new Error('Replacement source policy'); });
      check.release(); await rejected; expect(f.reads).toEqual([routed ? 'B' : 'A']);
    } finally { check.release(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }, 10000);
}

it('rejects a held cross-provider router result after reader disposal without reinterpreting its source locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-cross-provider-held-')); const f = fixture(); const route = barrier();
  const directory = createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, new SessionReferenceStore(root, 'claude'));
  directory.setSourceAccessCheck!(async () => { throw new Error('Cross-provider sources must not be authorized as local native IDs'); });
  directory.setSourceBindingReader!(async () => {
    await route.hold(); return { entries: [], sourceSessionId: 'foreign', sourceRef: { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'foreign' } };
  });
  try {
    await directory.create({ sourceNativeSessionId: 'A' });
    const read = f.configurations[0]!.tools!.find(tool => tool.name === 'read_source_session')!;
    const pending = read.execute({}); const rejected = expect(pending).rejects.toThrow(/closed|control/i);
    await route.entered(); await (await directory.open('reader')).dispose(); route.release(); await rejected;
    expect(f.reads).toEqual([]);
  } finally { route.release(); await directory.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);
