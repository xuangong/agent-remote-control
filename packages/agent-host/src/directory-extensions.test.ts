import { expect, it } from 'vitest';
import type { AgentSession, AgentSessionConfig, AgentSessionExtensions, AgentPersistenceHandle, AgentSessionResumeOptions } from '@orchardworks/agent-provider-sdk';
import { createCodexSessionDirectory } from './directory.js';
import { createManagedStdioDirectory } from './stdio-directory.js';

function extensions(calls: string[], label = 'original'): AgentSessionExtensions {
  return { instructions: 'Coordinate this delivery.', systemPrompt: 'Use the work record.', tools: [{
    name: 'read_work', description: 'Read the current work record.',
    inputSchema: { type: 'object', properties: { revision: { type: 'number' } }, required: ['revision'] },
    async execute() { calls.push(label); return label; },
  }] };
}

function harness(providerId: 'codex' | 'claude' | 'copilot') {
  const created: AgentSessionConfig[] = [];
  const resumed: (AgentSessionExtensions | undefined)[] = [];
  const resumes: Array<{handle: AgentPersistenceHandle; options?: AgentSessionResumeOptions}> = [];
  let disposals = 0;
  let pauseResume: (() => Promise<void>) | undefined;
  let rejectRuntimeInfo=false;
  function native(bound: AgentSessionExtensions = {}): AgentSession {
    let closed = false;
    return {
      capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        interactions: { question: false, planApproval: false, toolApproval: false } },
      async *observe() { yield { type: 'history_boundary' }; },
      async runtimeInfo() { if(rejectRuntimeInfo)throw new Error('Local runtime publication unavailable');return { providerId, sessionId: 'native', status: closed ? 'closed' : 'idle',
        persistence: { providerId, sessionId: 'native', opaque: '{}' } }; },
      async sendMessage() { await bound.tools?.[0]?.execute({ revision: 1 }); },
      async respondToInteraction() {},
      async dispose() { closed = true; disposals++; },
    };
  }
  const methods = {
    async createSession(config: AgentSessionConfig) { created.push(config); return native(config); },
    async resumeSession(handle: AgentPersistenceHandle, bound?: AgentSessionExtensions, options?: AgentSessionResumeOptions) {
      resumes.push({handle, options});
      resumed.push(bound); await pauseResume?.(); return native(bound);
    },
    async openChildSession() { return native(); },
  };
  const directory = providerId === 'codex'
    ? createCodexSessionDirectory({ ...methods, listSessions: async () => ({ sessions: [] }) }, [])
    : createManagedStdioDirectory(providerId, providerId, { ...methods, listSessions: async () => [] }, []);
  return { directory, created, resumed, resumes, disposals: () => disposals, failRuntimeInfo:()=>{rejectRuntimeInfo=true;},
    pauseResume: (pause: () => Promise<void>) => { pauseResume = pause; } };
}

it.each(['codex','claude','copilot'] as const)('%s reports native create completion before local runtime publication failure',async providerId=>{
  const h=harness(providerId);let completed=false;h.failRuntimeInfo();
  try {
    await expect(h.directory.create({}, {completed(){completed=true;}})).rejects.toThrow(/Local runtime publication/);
    expect(completed).toBe(true);expect(h.created).toHaveLength(1);
  }finally{await h.directory.close();}
},5000);

it.each(['codex', 'claude', 'copilot'] as const)('%s rejects binding TPM extensions to a cached ordinary runtime', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  try {
    const id = await h.directory.create({});
    await expect(h.directory.open(id, { extensions: extensions(calls) })).rejects.toThrow(/extensions.*reopen/i);
    expect(h.created).toHaveLength(1); expect(h.resumed).toHaveLength(0); expect(h.disposals()).toBe(0);
    await (await h.directory.open(id)).sendMessage('The ordinary session remains available.');
    expect(calls).toEqual([]);
  } finally { await h.directory.close(); }
});

it.each(['codex', 'claude', 'copilot'] as const)('%s reuses equivalent TPM extensions with fresh callback closures', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  try {
    const id = await h.directory.create(extensions(calls));
    const fresh = extensions(calls, 'fresh');
    fresh.tools![0]!.inputSchema = { required: ['revision'], properties: { revision: { type: 'number' } }, type: 'object' };
    const session = await h.directory.open(id, { extensions: fresh });
    await session.sendMessage('Read the bound record.');
    expect(await h.directory.open(id)).toBe(session);
    expect(calls).toEqual(['original']); expect(h.created).toHaveLength(1); expect(h.resumed).toHaveLength(0);
  } finally { await h.directory.close(); }
});

const changes: Array<[string, (value: AgentSessionExtensions) => void]> = [
  ['instructions', value => { value.instructions = 'A different delivery.'; }],
  ['system prompt', value => { value.systemPrompt = 'A different base prompt.'; }],
  ['tool name', value => { value.tools![0]!.name = 'update_work'; }],
  ['tool description', value => { value.tools![0]!.description = 'Read another record.'; }],
  ['tool schema', value => { value.tools![0]!.inputSchema = { type: 'object', properties: { revision: { type: 'string' } } }; }],
];
for (const providerId of ['codex', 'claude', 'copilot'] as const) {
  it.each(changes)(`${providerId} rejects a changed cached %s without replacing the runtime`, async (_field, change) => {
    const h = harness(providerId); const calls: string[] = [];
    try {
      const id = await h.directory.create(extensions(calls));
      const changed = extensions(calls, 'changed'); change(changed);
      await expect(h.directory.open(id, { extensions: changed })).rejects.toThrow(/extensions.*reopen/i);
      expect(h.created).toHaveLength(1); expect(h.resumed).toHaveLength(0); expect(h.disposals()).toBe(0);
      await (await h.directory.open(id)).sendMessage('The original binding still works.');
      expect(calls).toEqual(['original']);
    } finally { await h.directory.close(); }
  });
}

it.each(['codex', 'claude', 'copilot'] as const)('%s forwards extensions on cold resume and validates the resumed cache', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  try {
    const first = await h.directory.open('native', { extensions: extensions(calls) });
    await first.dispose();
    const next = await h.directory.open('native', { extensions: extensions(calls, 'resumed') });
    await next.sendMessage('Read after cold resume.');
    const changed = extensions(calls, 'changed'); changed.instructions = 'Another delivery.';
    await expect(h.directory.open('native', { extensions: changed })).rejects.toThrow(/extensions.*reopen/i);
    expect(h.resumed).toHaveLength(2); expect(calls).toEqual(['resumed']); expect(h.disposals()).toBe(1);
  } finally { await h.directory.close(); }
});

it.each(['claude', 'copilot'] as const)('%s checks extension identity after waiting for an ordinary concurrent open', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  h.pauseResume(async () => { started(); await gate; });
  try {
    const ordinary = h.directory.open('native'); await ready;
    const tpm = h.directory.open('native', { extensions: extensions(calls) });
    const rejected = expect(tpm).rejects.toThrow(/extensions.*reopen/i);
    release(); await ordinary; await rejected;
    expect(h.resumed).toHaveLength(1); expect(h.disposals()).toBe(0); expect(calls).toEqual([]);
  } finally { release(); await h.directory.close(); }
});


it.each(['codex', 'claude', 'copilot'] as const)('%s binds original creation independently of updated empty settings', async providerId => {
  const h = harness(providerId);
  const handle = {providerId, sessionId:'native', opaque:'original empty descriptor'};
  const nativeCreation = {status:'created' as const, handle};
  const updated = {...handle, opaque:'latest confirmed empty settings'};
  try {
    const session = await h.directory.open('native', {nativeCreation, resumeHandle:updated, resumeOptions:{initializeEmpty:true}});
    expect(h.resumes[0]?.handle).toEqual(updated);
    if(providerId !== 'codex') expect(h.resumes[0]?.options).toEqual({initializeEmpty:true});
    expect(await h.directory.open('native', {nativeCreation})).toBe(session);
    await expect(h.directory.open('native', {nativeCreation:{...nativeCreation, handle:{...handle, opaque:'another descriptor'}}})).rejects.toThrow(/original native creation/);
    await expect(h.directory.open('native', {nativeCreation, resumeHandle:{...updated, sessionId:'other'}})).rejects.toThrow(/authorize/);
    expect(h.resumes).toHaveLength(1);
  } finally {await h.directory.close();}
});

it.each(['codex', 'opencode'] as const)('%s native prefix attaches extensions once and resumes the exact original handle', async providerId => {
  const { createOpenCodeSessionDirectory } = await import('./opencode-directory.js');
  let bound: AgentSessionExtensions = {}, forks = 0, verifies = 0, completed = false;
  const handle = { providerId, sessionId: 'branch', opaque: 'original prefix\nconfig' }, resumed: unknown[] = [];
  const calls: string[] = [], ext = extensions(calls);
  const session = (): AgentSession => ({ capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: {question:false,toolApproval:false,planApproval:false} },
    async runtimeInfo() { expect(completed || !forks).toBe(true); return { providerId, sessionId: 'branch', cwd: '/work', status: 'idle', persistence: handle }; },
    async *observe(){yield {type:'history_boundary'};}, async sendMessage(){ await bound.tools?.[0]?.execute({revision:1}); },async respondToInteraction(){},async dispose(){} });
  const provider = { nativePrefix: { createdSessionIdMaxLength: 36, async validate(){}, async create(_target: unknown, extensions: AgentSessionExtensions, checkpoint: (handle: AgentPersistenceHandle) => Promise<void>) { forks++; bound = extensions; await checkpoint(handle); return session(); },
    async verify(_target: unknown, original: AgentPersistenceHandle){expect(original).toEqual(handle);verifies++;} },
    async createSession(){throw new Error('empty create invoked');}, async openChildSession(){throw new Error('child invoked');}, async resumeSession(original: AgentPersistenceHandle, extensions?: AgentSessionExtensions, options?: AgentSessionResumeOptions){resumed.push({original,options});bound=extensions??{};return session();},
    async getSession(){return {id:'branch',cwd:'/work'} as never;},async renameSession(){},async close(){} };
  const make = () => providerId === 'codex' ? createCodexSessionDirectory({...provider,listSessions:async()=>({sessions:[]})},[]) : createOpenCodeSessionDirectory({...provider,listSessions:async()=>[]},[],undefined,true);
  const directory = make(), target = { nativeSessionId:'source',turnId:'turn',messageId:'message' };
  try {
    expect(await directory.supportsNativePrefix!(target)).toBe(true);
    expect(await directory.createNativePrefix!(target,ext,{completed(){completed=true;}},async original => { expect(original).toEqual(handle); expect(completed).toBe(false); })).toEqual(handle);
    const opened = await directory.open('branch',{nativePrefix:handle,extensions:ext});
    await opened.sendMessage('invoke bound callback');expect(calls).toEqual(['original']);expect(forks).toBe(1);expect(resumed).toEqual([]);
    await directory.verifyNativePrefix!(target,handle);expect(verifies).toBe(1);
    await expect(directory.open('branch',{nativePrefix:{...handle,opaque:'changed'},extensions:ext})).rejects.toThrow(/prefix/);
    const restored=make();
    try { await restored.open('branch',{nativePrefix:handle,extensions:ext});expect(resumed).toEqual([{original:handle,options:undefined}]); }finally{await restored.close();}
  } finally {await directory.close();}
},5000);
