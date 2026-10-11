import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';

function fixture() {
  const records: any[] = [], launches: any[] = [], inputs: any[] = [];
  const events = new Channel<any>();
  let info: any;
  let effort: string | null = null;
  let appliedOverride: string | null | undefined;
  let nativeModel = 'default';
  const query = vi.fn(({ prompt, options }: any) => {
    launches.push(options);
    void (async () => { for await (const input of prompt) inputs.push(input); })();
    return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), initializationResult: async () => ({ models: [{ value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'sonnet', displayName: 'Sonnet' }] }),
      close: () => events.close(), setPermissionMode: async () => {}, setModel: async (model: string) => { nativeModel = model; },
      supportedModels: async () => [{ value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'sonnet', displayName: 'Sonnet' }],
      applyFlagSettings: async (settings: any) => { effort = appliedOverride === undefined ? settings.effortLevel : appliedOverride; }, getSettings: async () => ({ applied: { effort, model: nativeModel } }) } as any;
  });
  const provider = new ClaudeAgentProvider({ query, env: { CLAUDE_CONFIG_DIR: '/isolated/claude-evidence' },
    catalog: { list: async () => [], info: async () => info, messages: async () => records, children: async () => [] } });
  return { provider, query, records, launches, inputs, events, setInfo(value: any) { info = value; }, setNativeModel(value: string) { nativeModel = value; },
    setNativeEffort(value: string | null) { effort = value; }, forceAppliedEffort(value: string | null) { appliedOverride = value; } };
}
async function tick() { await pause(0); }

const sid = '11111111-1111-4111-8111-111111111111';

describe('Claude native evidence', () => {
  it('prepares a durable empty descriptor without launching or submitting, and requires explicit initialization permission', async () => {
    const f = fixture();
    const result = await f.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd() });
    expect(result.status).toBe('created'); if (result.status !== 'created') return;
    expect(f.query).not.toHaveBeenCalled();
    expect(await f.provider.sessionWorkspace(sid, result.handle)).toBe(process.cwd());
    await expect(f.provider.resumeSession(result.handle)).rejects.toThrow(/unavailable/);
    expect(f.query).not.toHaveBeenCalled();
    const session = await f.provider.resumeSession(result.handle, {}, { initializeEmpty: true });
    try {
      expect(f.launches[0]).toMatchObject({ sessionId: sid, cwd: process.cwd() });
      expect(f.launches[0]).not.toHaveProperty('resume');
      expect(f.inputs).toEqual([]);
      expect(session.nativeEvidence?.availability()).toEqual({ status: 'configured', version: 2 });
      expect(await session.nativeEvidence?.inspectReadiness()).toEqual({ cwd: process.cwd(), idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 });
    } finally { await session.dispose(); }
  });

  it('prioritizes native history and rejects foreign descriptors even with initialization permission', async () => {
    const f = fixture();
    const result = await f.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd() });
    if (result.status !== 'created') throw new Error('Missing descriptor');
    await expect(f.provider.resumeSession({ ...result.handle, sessionId: randomUUID() }, {}, { initializeEmpty: true })).rejects.toThrow();
    const foreign = new ClaudeAgentProvider({ query: f.query, env: { CLAUDE_CONFIG_DIR: '/other-profile' }, catalog: { list: async () => [], info: async () => undefined, messages: async () => [] } });
    await expect(foreign.resumeSession(result.handle, {}, { initializeEmpty: true })).rejects.toThrow();
    await expect(f.provider.resumeSession({ providerId: 'claude', sessionId: sid, opaque: JSON.stringify({ cwd: process.cwd() }) }, {}, { initializeEmpty: true })).rejects.toThrow(/unavailable/);
    f.setInfo({ sessionId: sid, cwd: process.cwd() });
    const session = await f.provider.resumeSession(result.handle, {}, { initializeEmpty: true });
    try { expect(f.launches[0].resume).toBe(sid); expect(f.launches[0]).not.toHaveProperty('sessionId'); }
    finally { await session.dispose(); }
  });

  it('retains confirmed empty-session settings in its updated descriptor', async () => {
    const f = fixture();
    const result = await f.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd() });
    if (result.status !== 'created') throw new Error('Missing descriptor');
    const session = await f.provider.resumeSession(result.handle, {}, { initializeEmpty: true });
    await session.setSessionSetting!('reasoning_effort', 'high');
    await session.setSessionSetting!('model', 'sonnet');
    await session.setSessionSetting!('permissions', 'acceptEdits');
    f.events.push({ type: 'user', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>Set model to sonnet</local-command-stdout>' } });
    await tick();
    const saved = (await session.runtimeInfo()).persistence!;
    await session.dispose();
    const second = fixture();
    const reopened = await second.provider.resumeSession(saved, {}, { initializeEmpty: true });
    try { expect(second.launches[0]).toMatchObject({ sessionId: sid, model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits' }); }
    finally { await reopened.dispose(); }
  });

  it('inherits the latest confirmed effort override and removes an override cleared by native readback', async () => {
    const f = fixture(); f.setNativeEffort('high');
    const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd(), reasoningEffort: 'high' });
    try {
      f.setNativeEffort('low');
      const refreshed = await session.runtimeInfo({ refreshSettings: true });
      expect(JSON.parse(refreshed.persistence!.opaque).reasoningEffort).toBe('low');
      const result = await f.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd(), selectionSourceSessionId: refreshed.sessionId });
      if (result.status !== 'created') throw new Error('Missing descriptor');
      expect(JSON.parse(result.handle.opaque).config.reasoningEffort).toBe('low');
      f.setNativeEffort(null);
      const cleared = await session.runtimeInfo({ refreshSettings: true });
      expect(JSON.parse(cleared.persistence!.opaque).reasoningEffort).toBeUndefined();
      const next = await f.provider.nativeEvidence.createEmpty({ sessionId: randomUUID(), cwd: process.cwd(), selectionSourceSessionId: refreshed.sessionId });
      if (next.status !== 'created') throw new Error('Missing descriptor');
      expect(JSON.parse(next.handle.opaque).config.reasoningEffort).toBeUndefined();
    } finally { await session.dispose(); }
  });

  it('does not persist a requested effort after native readback confirms no override', async () => {
    const f = fixture();
    const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
    try {
      f.forceAppliedEffort(null);
      await expect(session.setSessionSetting!('reasoning_effort', 'high')).rejects.toThrow(/no effort parameter/);
      expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque).reasoningEffort).toBeUndefined();
    } finally { await session.dispose(); }
  });

  it('prepares without input, dispatches the exact UUID once, and separates materialization from execution', async () => {
    const f = fixture();
    const result = await f.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd() });
    if (result.status !== 'created') throw new Error('Missing descriptor');
    const session = await f.provider.resumeSession(result.handle, {}, { initializeEmpty: true });
    try {
      const evidence = session.nativeEvidence!;
      const witness = await evidence.prepareInput([{ type: 'text', text: 'Exact first input' }]);
      expect(f.inputs).toEqual([]);
      await evidence.dispatchInput(witness); await tick();
      expect(f.inputs).toHaveLength(1);
      expect(f.inputs[0]).toMatchObject({ uuid: witness.inputId, session_id: sid, message: { content: 'Exact first input' } });
      await expect(evidence.dispatchInput(witness)).rejects.toThrow();
      expect(await evidence.inspectInput(witness)).toMatchObject({ status: 'unknown' });
      f.records.push(f.inputs[0]);
      expect(await evidence.inspectInput(witness)).toMatchObject({ status: 'materialized', proof: { inputId: witness.inputId, nativeInputId: witness.inputId } });
      expect(await evidence.inspectInput(witness)).not.toHaveProperty('execution');
      f.events.push({ type: 'assistant', session_id: sid, uuid: randomUUID(), user_message_uuid: 'unrelated', parent_tool_use_id: null, message: { id: 'other', role: 'assistant', content: [] } });
      f.events.push({ type: 'assistant', session_id: sid, uuid: randomUUID(), user_message_uuid: witness.inputId, parent_tool_use_id: 'child-tool', message: { id: 'child', role: 'assistant', content: [] } });
      await tick(); expect(await evidence.inspectInput(witness)).not.toHaveProperty('execution');
      const nativeExecutionId = randomUUID();
      f.events.push({ type: 'stream_event', session_id: sid, uuid: nativeExecutionId, user_message_uuid: witness.inputId, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'native-response', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } } });
      await tick();
      expect(await evidence.inspectInput(witness)).toMatchObject({ status: 'materialized', execution: { disposition: 'started', nativeExecutionId } });
      expect(f.inputs).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it('invalidates tokens for native work and requires authoritative idle after a result', async () => {
    const f = fixture(); const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
    try {
      const id = (await session.runtimeInfo()).sessionId, evidence = session.nativeEvidence!;
      const token = evidence.captureValidity();
      const accepted = vi.fn();
      await session.sendMessage('Start work', { onAcceptance: accepted }); await tick();
      expect(evidence.isCurrent(token)).toBe(false); expect(accepted).not.toHaveBeenCalled();
      const input = f.inputs[0];
      f.events.push({ type: 'assistant', uuid: randomUUID(), session_id: id, parent_tool_use_id: null, user_message_uuid: input.uuid, message: { id: 'native-response', role: 'assistant', content: [] } });
      await tick(); expect(accepted).toHaveBeenCalledExactlyOnceWith({ disposition: 'started' });
      f.events.push({ type: 'result', subtype: 'success', uuid: randomUUID(), session_id: id, user_message_uuid: input.uuid, is_error: false, result: 'done', usage: {}, modelUsage: {}, queued_turn_count: 0 });
      await tick(); expect((await evidence.inspectReadiness()).idle).toBe(false);
      f.events.push({ type: 'system', subtype: 'session_state_changed', uuid: randomUUID(), session_id: id, state: 'idle' });
      await tick(); expect((await evidence.inspectReadiness()).idle).toBe(true);
      const ready = evidence.captureValidity();
      f.events.push({ type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(), session_id: id, tasks: [{ task_id: 'work', task_type: 'agent', description: 'Working' }, { task_id: 'ambient', task_type: 'watcher', description: 'Housekeeping', ambient: true }] });
      await tick(); expect(evidence.isCurrent(ready)).toBe(false); expect((await evidence.inspectReadiness()).activeChildren).toBe(1);
    } finally { await session.dispose(); }
  });
});

it('rejects stale preparation and never replays a witness after cold reattachment', async () => {
  const f = fixture();
  const created = await f.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd() });
  if (created.status !== 'created') throw new Error('Missing descriptor');
  const session = await f.provider.resumeSession(created.handle, {}, { initializeEmpty: true });
  const stale = await session.nativeEvidence!.prepareInput([{ type: 'text', text: 'Old settings' }]);
  await session.setSessionSetting!('permissions', 'acceptEdits');
  await expect(session.nativeEvidence!.dispatchInput(stale)).rejects.toThrow();
  const witness = await session.nativeEvidence!.prepareInput([{ type: 'text', text: 'Saved input' }]);
  await session.nativeEvidence!.dispatchInput(witness); await tick();
  const handle = (await session.runtimeInfo()).persistence!;
  expect(JSON.parse(handle.opaque).kind).not.toBe('claude-empty-session');
  const record = f.inputs[0]; await session.dispose();
  const cold = fixture(); cold.setInfo({ sessionId: sid, cwd: process.cwd() }); cold.records.push(record);
  const resumed = await cold.provider.resumeSession(handle);
  try {
    expect(await resumed.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'materialized', proof: { inputId: witness.inputId, nativeInputId: witness.inputId } });
    expect(await resumed.nativeEvidence!.inspectInput(witness)).not.toHaveProperty('execution');
    await expect(resumed.nativeEvidence!.dispatchInput(witness)).rejects.toThrow();
    cold.records.length = 0;
    expect(await resumed.nativeEvidence!.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_readback_missing' });
    await expect(resumed.nativeEvidence!.dispatchInput(witness)).rejects.toThrow();
    expect(cold.inputs).toEqual([]);
  } finally { await resumed.dispose(); }
});

it('does not use a text match, child input or duplicate UUID as materialization proof', async () => {
  const f = fixture(); const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
  try {
    const evidence = session.nativeEvidence!, witness = await evidence.prepareInput([{ type: 'text', text: 'Same words' }]);
    const record = { type: 'user', uuid: witness.inputId, session_id: witness.nativeSessionId, parent_tool_use_id: null, message: { role: 'user', content: 'Same words' } };
    f.records.push({ ...record, uuid: randomUUID() });
    expect(await evidence.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_readback_missing' });
    f.records[0] = { ...record, parent_tool_use_id: 'child' };
    expect(await evidence.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_readback_mismatch' });
    f.records[0] = record; f.records.push(record);
    expect(await evidence.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_readback_mismatch' });
  } finally { await session.dispose(); }
});

it('keeps readiness unavailable after shutdown and fences pending settings and native state changes', async () => {
  const f = fixture(); const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
  const evidence = session.nativeEvidence!;
  const token = evidence.captureValidity();
  f.events.push({ type: 'system', subtype: 'session_state_changed', uuid: randomUUID(), session_id: (await session.runtimeInfo()).sessionId, state: 'requires_action' });
  await tick(); expect(evidence.isCurrent(token)).toBe(false);
  expect((await evidence.inspectReadiness()).idle).toBe(false);
  await expect(evidence.prepareInput([{ type: 'text', text: 'Not ready' }])).rejects.toThrow();
  await session.dispose();
  expect(evidence.isCurrent(token)).toBe(false);
  await expect(evidence.inspectReadiness()).rejects.toThrow();
});

for (const complete of [false, true]) it(`requires a complete Stop snapshot and the exact zero-queue result (${complete})`, async () => {
  const f = fixture(); const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
  try {
    await session.sendMessage('Work'); await tick(); const input = f.inputs[0];
    await f.launches[0].hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', session_id: input.session_id, cwd: process.cwd(), ...(complete ? { background_tasks: [], session_crons: [] } : {}) });
    f.events.push({ type: 'result', subtype: 'success', uuid: randomUUID(), session_id: input.session_id, user_message_uuid: input.uuid, is_error: false, result: 'done', usage: {}, modelUsage: {}, queued_turn_count: 0 });
    await tick(); expect((await session.nativeEvidence!.inspectReadiness()).idle).toBe(complete);
  } finally { await session.dispose(); }
});

it('blocks succession while a Stop snapshot includes background work or scheduled wakeups', async () => {
  const f = fixture(); const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
  try {
    await session.sendMessage('Work'); await tick(); const input = f.inputs[0];
    await f.launches[0].hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', session_id: input.session_id, cwd: process.cwd(), background_tasks: [], session_crons: [{ id: 'scheduled' }] });
    f.events.push({ type: 'result', subtype: 'success', uuid: randomUUID(), session_id: input.session_id, user_message_uuid: input.uuid, is_error: false, result: 'done', usage: {}, modelUsage: {}, queued_turn_count: 0 });
    await tick(); expect((await session.nativeEvidence!.inspectReadiness()).activeChildren).toBe(1);
    await expect(session.nativeEvidence!.prepareInput([{ type: 'text', text: 'Not quiescent' }])).rejects.toThrow();
  } finally { await session.dispose(); }
});

it('treats unsolicited native activity as work even without an adapter-owned input', async () => {
  const f = fixture(); const session = await f.provider.createSession({ sessionId: sid, cwd: process.cwd() });
  try {
    const evidence = session.nativeEvidence!, token = evidence.captureValidity();
    f.events.push({ type: 'stream_event', session_id: (await session.runtimeInfo()).sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'autonomous-response', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } } } });
    await tick(); expect(evidence.isCurrent(token)).toBe(false); expect((await evidence.inspectReadiness()).idle).toBe(false);
    await expect(evidence.prepareInput([{ type: 'text', text: 'Not idle' }])).rejects.toThrow();
  } finally { await session.dispose(); }
});

it('resumes the native model instead of overriding it from an old empty descriptor', async () => {
  const first = fixture(); const source = await first.provider.createSession({ sessionId: sid, cwd: process.cwd(), model: 'sonnet' });
  const result = await first.provider.nativeEvidence.createEmpty({ sessionId: sid, cwd: process.cwd(), selectionSourceSessionId: (await source.runtimeInfo()).sessionId });
  await source.dispose(); if (result.status !== 'created') throw new Error('Missing descriptor');
  const cold = fixture(); cold.setInfo({ sessionId: sid, cwd: process.cwd() }); cold.setNativeModel('native-updated-model');
  const session = await cold.provider.resumeSession(result.handle);
  try { expect(cold.launches[0].model).toBeUndefined(); expect((await session.runtimeInfo()).model).toBe('native-updated-model'); }
  finally { await session.dispose(); }
});
