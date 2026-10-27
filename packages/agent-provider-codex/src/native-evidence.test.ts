import { realpathSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

function fixture() {
  const cwd = realpathSync(process.cwd());
  const requests: Array<{ method: string; params: any }> = [];
  const turns: any[] = [];
  const children: any[] = [];
  const overrides = new Map<string, (params: any) => unknown>();
  let notify = (_method: string, _params: unknown) => {};
  let queued = 0;
  let responseLost = false;
  const settings = { model: 'model', modelProvider: 'native', reasoningEffort: 'medium', cwd,
    approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } };
  const thread = () => ({ id: 'native-B', cwd, model: settings.model, modelProvider: settings.modelProvider, reasoningEffort: settings.reasoningEffort,
    status: { type: 'idle' }, parentThreadId: null, canAcceptDirectInput: true, turns });
  const provider = new CodexAppServerProvider({ env: { CODEX_HOME: cwd }, spawn: () => {
    const handlers: Record<string, (params: any) => unknown> = {
      'thread/start': () => ({ ...settings, thread: thread() }),
      'thread/resume': () => ({ ...settings, thread: thread() }),
      'thread/read': () => ({ thread: thread() }),
      'thread/settings/update': params => {
        if (params.model) settings.model = params.model;
        if (params.effort !== undefined) settings.reasoningEffort = params.effort;
        if (params.approvalPolicy) settings.approvalPolicy = params.approvalPolicy;
        if (params.sandboxPolicy) settings.sandbox = params.sandboxPolicy;
        app.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'native-B',
          threadSettings: { ...settings, effort: settings.reasoningEffort, sandboxPolicy: settings.sandbox } } })}\n`);
        return {};
      },
      'thread/turns/list': () => ({ data: [...turns].reverse(), nextCursor: null }),
      'thread/list': () => ({ data: children, nextCursor: null }),
      'thread/queue/list': () => ({ data: Array.from({ length: queued }, (_, index) => ({ id: `q-${index}` })), nextCursor: null }),
      'collaborationMode/list': () => ({ data: [] }),
      'turn/start': params => {
        turns.push({ id: `turn-${turns.length}`, status: 'completed', items: [{ type: 'userMessage', id: `user-${turns.length}`,
          clientId: params.clientUserMessageId, content: params.input }] });
        if (responseLost) throw new Error('native response lost after input acceptance');
        return { turn: { id: turns.at(-1).id, status: 'inProgress' } };
      },
    };
    const app = createScriptedAppServer(Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, params => {
      requests.push({ method, params }); return (overrides.get(method) ?? handler)(params);
    }])));
    notify = (method, params) => app.child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    app.child.stdin.once('finish', () => app.child.emitExit());
    return app.child;
  } });
  return { provider, cwd, requests, turns, settings, children, overrides, notify: (method: string, params: unknown) => notify(method, params),
    queue: (count: number) => { queued = count; }, loseResponse: () => { responseLost = true; } };
}

it('creates a zero-input native successor and restores its confirmed selection', async () => {
  const f = fixture();
  const creation = await f.provider.nativeEvidence!.createEmpty({ sessionId: 'logical', cwd: f.cwd });
  expect(creation.status).toBe('created');
  if (creation.status !== 'created') return;
  expect(f.requests.some(request => request.method === 'turn/start')).toBe(false);
  f.settings.reasoningEffort = 'low';
  const session = await f.provider.resumeSession(creation.handle);
  try {
    expect(await session.nativeEvidence!.inspectReadiness()).toEqual({ cwd: f.cwd, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 });
    const restored = f.requests.find(request => request.method === 'thread/settings/update')!.params;
    expect(restored.effort).toBe('medium');
    expect(restored.approvalPolicy).toBe('never');
  } finally { await session.dispose(); }
});

it('registers the role it takes over when it creates an empty successor, replacing the source instructions', async () => {
  const f = fixture();
  const source = await f.provider.createSession({ sessionId: 'source', cwd: f.cwd, instructions: 'Source role' });
  try {
    const tool = { name: 'read_team', description: 'Read the Team', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => 'unbound' };
    const creation = await f.provider.nativeEvidence.createEmpty({ sessionId: 'successor', cwd: f.cwd, selectionSourceSessionId: 'native-B',
      extensions: { instructions: 'Team role', tools: [tool] } });
    expect(creation.status).toBe('created');
    const start = f.requests.filter(request => request.method === 'thread/start').at(-1)!.params;
    expect(start.developerInstructions).toBe('Team role');
    expect(start.dynamicTools).toEqual([{ type: 'function', name: 'read_team', description: 'Read the Team', inputSchema: tool.inputSchema }]);
    if (creation.status === 'created') expect(JSON.parse(creation.handle.opaque).instructions).toBe('Team role');
  } finally { await source.dispose(); }
});

it('uses authoritative native queue state to reject preparation while input is pending', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    f.queue(1);
    expect(await session.nativeEvidence!.inspectReadiness()).toMatchObject({ pendingInputs: 1 });
    expect(() => session.nativeEvidence!.captureValidity()).toThrow();
    await expect(session.nativeEvidence!.prepareInput([{ type: 'text', text: 'first input' }])).rejects.toMatchObject({ code: 'native_evidence_admission' });
    expect(f.requests.some(request => request.method === 'turn/start')).toBe(false);
  } finally { await session.dispose(); }
});

it('retains planning through empty creation and cold resume and binds dispatch to the selected mode', async () => {
  const f = fixture();
  f.overrides.set('collaborationMode/list', () => ({ data: [{ mode: 'plan', model: 'model' }, { mode: 'default', model: 'model' }] }));
  const source = await f.provider.createSession({ sessionId: 'source', cwd: f.cwd, planning: true });
  let target: Awaited<ReturnType<CodexAppServerProvider['resumeSession']>> | undefined;
  try {
    const creation = await f.provider.nativeEvidence.createEmpty({ sessionId: 'successor', cwd: f.cwd, selectionSourceSessionId: 'native-B' });
    if (creation.status !== 'created') throw new Error('Expected an empty session');
    await source.dispose();
    target = await f.provider.resumeSession(creation.handle);
    expect((await target.runtimeInfo()).planning?.active).toBe(true);
    const witness = await target.nativeEvidence!.prepareInput([{ type: 'text', text: 'first input' }]);
    expect(JSON.parse(witness.selections.providerOptions!).collaborationMode.mode).toBe('plan');
    await target.setPlanning!(false);
    await expect(target.nativeEvidence!.dispatchInput(witness)).rejects.toMatchObject({ code: 'native_evidence_stale' });
    expect(f.requests.some(request => request.method === 'turn/start')).toBe(false);
    await target.setPlanning!(true);
    const current = await target.nativeEvidence!.prepareInput([{ type: 'text', text: 'first input' }]);
    await target.nativeEvidence!.dispatchInput(current);
    expect(f.requests.find(request => request.method === 'turn/start')!.params.collaborationMode.mode).toBe('plan');
  } finally { await source.dispose(); await target?.dispose(); }
});

it('binds prepared input to clientId and reads the exact native message and turn', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    const witness = await session.nativeEvidence!.prepareInput([{ type: 'text', text: 'first input' }]);
    expect(witness.inputId).toEqual(expect.any(String));
    expect(await session.nativeEvidence!.dispatchInput(witness)).toEqual({ disposition: 'started' });
    const native = f.requests.find(request => request.method === 'turn/start')!.params;
    expect(native.clientUserMessageId).toBe(witness.inputId);
    expect(native.effort).toBe('medium');
    expect(native.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    const materialization = await session.nativeEvidence!.inspectInput(witness);
    expect(materialization).toMatchObject({ status: 'materialized', proof: { inputId: witness.inputId, nativeInputId: 'user-0' },
      execution: { disposition: 'started', nativeExecutionId: 'turn-0' } });
  } finally { await session.dispose(); }
});

it('retains an unknown send outcome and recovers by exact input identity without sending again', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    const witness = await session.nativeEvidence!.prepareInput([{ type: 'text', text: 'first input' }]);
    f.loseResponse();
    await expect(session.nativeEvidence!.dispatchInput(witness)).rejects.toMatchObject({ code: 'native_evidence_outcome_unknown' });
    expect(await session.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'materialized', proof: { inputId: witness.inputId } });
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    await expect(session.nativeEvidence!.dispatchInput(witness)).rejects.toMatchObject({ code: 'native_evidence_admission' });
    f.turns[0].items[0].clientId = 'another-client';
    expect(await session.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'unknown' });
  } finally { await session.dispose(); }
});

it('invalidates readiness tokens on input admission and returns normal started acceptance from the native receipt', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    await session.nativeEvidence!.inspectReadiness();
    const token = session.nativeEvidence!.captureValidity();
    expect(session.nativeEvidence!.isCurrent(token)).toBe(true);
    const observed: unknown[] = [];
    expect(await session.sendMessage('ordinary input', { onAcceptance: value => observed.push(value) })).toEqual({ disposition: 'started' });
    expect(observed).toEqual([{ disposition: 'started' }]);
    expect(session.nativeEvidence!.isCurrent(token)).toBe(false);
  } finally { await session.dispose(); }
});

it('does not restore creation settings over native changes after the first input', async () => {
  const f = fixture();
  const creation = await f.provider.nativeEvidence.createEmpty({ sessionId: 'logical', cwd: f.cwd });
  if (creation.status !== 'created') throw new Error('Expected an empty session');
  const session = await f.provider.resumeSession(creation.handle);
  await session.sendMessage('first input');
  await session.dispose();
  Object.assign(f.settings, { model: 'new-model', reasoningEffort: 'high', approvalPolicy: 'on-request', sandbox: { type: 'dangerFullAccess' } });
  const resumed = await f.provider.resumeSession(creation.handle);
  try {
    const witness = await resumed.nativeEvidence!.prepareInput([{ type: 'text', text: 'next input' }]);
    expect(witness.selections.model).toBe('new-model');
    expect(witness.selections.reasoningEffort).toBe('high');
    expect(JSON.parse(witness.selections.providerOptions!)).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' } });
  } finally { await resumed.dispose(); }
});

it('rejects handoff with active native children or missing authoritative queue facts', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    f.children.push({ id: 'child', parentThreadId: 'native-B', status: { type: 'active' } });
    expect(await session.nativeEvidence!.inspectReadiness()).toMatchObject({ activeChildren: 1 });
    await expect(session.nativeEvidence!.prepareInput([{ type: 'text', text: 'input' }])).rejects.toMatchObject({ code: 'native_evidence_admission' });
    f.children.length = 0;
    f.overrides.set('thread/queue/list', () => ({ data: [] }));
    await expect(session.nativeEvidence!.inspectReadiness()).rejects.toMatchObject({ code: 'native_evidence_unsupported' });
  } finally { await session.dispose(); }
});

it('re-reads a changed observation and rejects continuously changing readiness after bounded attempts', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    let reads = 0;
    f.overrides.set('thread/queue/list', () => {
      reads++;
      if (reads === 1) f.notify('thread/status/changed', { threadId: 'native-B', status: { type: 'idle' } });
      return { data: [], nextCursor: null };
    });
    expect(await session.nativeEvidence!.inspectReadiness()).toMatchObject({ idle: true });
    expect(reads).toBe(2);
    const token = session.nativeEvidence!.captureValidity();
    f.overrides.set('thread/queue/list', () => {
      f.notify('thread/status/changed', { threadId: 'native-B', status: { type: 'idle' } });
      return { data: [], nextCursor: null };
    });
    await expect(session.nativeEvidence!.inspectReadiness()).rejects.toMatchObject({ code: 'native_evidence_stale' });
    expect(session.nativeEvidence!.isCurrent(token)).toBe(false);
  } finally { await session.dispose(); }
});

it('does not prove duplicate native client IDs or an incomplete history scan', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'logical', cwd: f.cwd });
  try {
    const witness = await session.nativeEvidence!.prepareInput([{ type: 'text', text: 'input' }]);
    await session.nativeEvidence!.dispatchInput(witness);
    f.turns.push(structuredClone(f.turns[0]));
    expect(await session.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_readback_mismatch' });
    f.overrides.set('thread/turns/list', () => ({ data: [f.turns[0]], nextCursor: 'repeating' }));
    expect(await session.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'unknown' });
    f.overrides.set('thread/turns/list', () => ({ data: [], nextCursor: 'repeating' }));
    expect(await session.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_limit' });
  } finally { await session.dispose(); }
});
