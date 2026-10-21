import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentOperationRejectedError, type AgentMessageOptions, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { AgentManagerEvent, SessionWireAgent } from '@orchardworks/agent-remote-relay';
import type { TpmWork } from '@orchardworks/agent-remote-protocol';
import { TpmCoordinator, type TpmSessionAccess } from './tpm.js';

class SessionManager {
  readonly listeners = new Set<(event: AgentManagerEvent) => void>();
  readonly messages: Array<{ text: string; options: unknown }> = [];
  leases = 0;
  payload: any;
  sendFailure?: Error;
  constructor(readonly agentId: string, queueMessage = false) {
    this.payload = { id: agentId, status: 'idle', activeTurn: null, pendingInteractions: [],
      capabilities: { history: true, sendMessage: true, queueMessage, steer: true, cancel: true, readResource: false, interactions: { question: true, toolApproval: true, planApproval: false } },
      runtimeInfo: { providerId: 'codex', sessionId: agentId, status: 'idle', cwd: '/isolated/workspace', persistence: { providerId: 'codex', sessionId: agentId, opaque: 'private' } },
      persistence: { providerId: 'codex', sessionId: agentId, opaque: 'private' } };
  }
  snapshot() { return { type: 'agent_snapshot', payload: structuredClone(this.payload) } as any; }
  subscribe(listener: (event: AgentManagerEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async sendMessage(text: string, options?: unknown) {
    this.messages.push({ text, options });
    if (this.sendFailure) throw this.sendFailure;
    if (!(options as any)?.delivery) this.setStatus('running');
    return { disposition: (options as any)?.delivery ? 'queued' : 'started' } as const;
  }
  setStatus(status: string) {
    this.payload.status = status; this.payload.runtimeInfo.status = status;
    this.payload.activeTurn = status === 'running' ? { turnId: 'active', startedAt: new Date().toISOString() } : null;
    this.emit({ type: 'agent_state', agentId: this.agentId, snapshot: this.snapshot() });
  }
  emit(event: AgentManagerEvent) { for (const listener of this.listeners) listener(event); }
  stream(event: any, delivery: 'history' | 'live' = 'live') { this.emit({ type: 'agent_stream', agentId: this.agentId, event, delivery, timestamp: new Date().toISOString() }); }
  fetchTimeline(request: any) { return { payload: { entries: [{ seq: 1, item: { type: 'assistant_message', text: 'Bound evidence' } }], direction: request.direction, nextCursor: { epoch: 'epoch', seq: 1 } } } as any; }
  respondToInteraction = vi.fn(async () => {});
  cancel = vi.fn(async () => {});
  steer = vi.fn(async () => {});
}
const fixtures: Array<{ coordinator: TpmCoordinator; directory: string }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.coordinator.close(); await rm(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } });
async function fixture(queueMessage = false, tickMs = 1_000_000) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-tpm-coordinator-'));
  const sessions = new Map<string, SessionManager>([['main', new SessionManager('main', queueMessage)]]);
  let now = 1_000_000; let available = true; let supported = ['codex']; let createFailure: Error | undefined;
  const creates: AgentSessionExtensions[] = [];
  const access: TpmSessionAccess = {
    controllerId: 'controller',
    available: () => available, supportedProviders: () => supported,
    async acquire(_providerId, id) {
      const session = sessions.get(id); if (!session) throw new Error('Native session unavailable.');
      session.leases++; let released = false;
      return { agent: session as unknown as SessionWireAgent, release() { if (!released) { released = true; session.leases--; } } };
    },
    async create(_providerId, _cwd, extensions) {
      creates.push(extensions); if (createFailure) throw createFailure;
      const id = `tpm-${creates.length}`; sessions.set(id, new SessionManager(id)); return id;
    },
    async execute(_agent, _operation, work) { await work.validate?.(); work.beforeDispatch?.(); return work.dispatch(); },
  };
  const options = { stateDirectory: directory, now: () => now, tickMs, heartbeatMs: 1000, waitingHeartbeatMs: 5000, minimumReviewMs: 30, coalesceMs: 5 };
  let coordinator = new TpmCoordinator(options, access); fixtures.push({ coordinator, directory }); await coordinator.ready;
  const input = { providerId: 'codex', mainNativeSessionId: 'main', title: 'Deliver isolated work', requirement: 'Agree on scope and deliver evidence.', operationId: 'create-one', delegated: true };
  const create = async (operationId = input.operationId) => {
    const work = await coordinator.create({ ...input, operationId }, 'browser-scope');
    await expect.poll(async () => (await coordinator.get(work.id)).outbox?.[0]?.status).toBe('accepted');
    const current = await coordinator.get(work.id);
    const tool = (await coordinator.extensions(current.providerId, current.tpmNativeSessionId!))!.tools!.find(tool => tool.name === 'update_todo_step')!;
    await tool.execute({ revision: current.todo!.revision, stepId: current.todo!.steps[0]!.id, status: 'in_progress', note: 'Discussing the requirement' });
    return coordinator.get(work.id);
  };
  const tools = async (work: TpmWork) => (await coordinator.extensions(work.providerId, work.tpmNativeSessionId!))!.tools!;
  const call = async (work: TpmWork, name: string, args: unknown) => {
    const tool = (await tools(work)).find(tool => tool.name === name)!;
    if (name === 'send_main_message' && args && typeof args === 'object' && !('todoStepId' in args)) {
      const todo = (await coordinator.get(work.id)).todo!;
      args = { todoStepId: todo.steps.find(step => step.status !== 'completed')?.id, ...args };
    }
    return JSON.parse(await tool.execute(args));
  };
  const acknowledge = async (work: TpmWork, overrides: Record<string, unknown> = {}) => {
    const current = await coordinator.get(work.id);
    const result = await call(current, 'update_work', { revision: current.revision, phase: 'implementing', waiting: 'main_session', summary: 'Scope agreed', nextAction: 'Wait for evidence', ...overrides });
    sessions.get(work.tpmNativeSessionId!)!.setStatus('idle');
    return result as TpmWork;
  };
  const advanceTodo = async (work: TpmWork) => {
    const todo = (await coordinator.get(work.id)).todo!;
    const step = todo.steps.find(step => step.status !== 'completed');
    if (!step) return false;
    if (step.kind === 'confirmation') {
      const requested = await call(work, 'request_todo_confirmation', { revision: todo.revision, stepId: step.id, content: 'Explicit test user approval of the current proposal' });
      const current = await coordinator.get(work.id);
      await coordinator.action({ id: work.id, revision: current.revision, operationId: 'approve-' + step.id, action: 'confirm_todo', confirmation: { revision: requested.revision, stepId: step.id, requestId: requested.steps.find((item: any) => item.id === step.id).confirmation.id, decision: 'approve' } }, 'test-user');
    } else {
      let started = todo;
      if (step.status === 'pending') started = await call(work, 'update_todo_step', { revision: todo.revision, stepId: step.id, status: 'in_progress', note: 'Working on this step' });
      await call(work, 'complete_todo_step', { revision: started.revision, stepId: step.id, evidence: ['Step-specific acceptance evidence'] });
    }
    return true;
  };
  return { directory, sessions, access, creates, input, create, call, acknowledge, advanceTodo,
    get coordinator() { return coordinator; }, get now() { return now; }, advance(ms: number) { now += ms; },
    setAvailable(value: boolean) { available = value; }, setSupported(value: string[]) { supported = value; }, failCreate(error: Error) { createFailure = error; },
    async restart() { await coordinator.close(); coordinator = new TpmCoordinator(options, access); fixtures.find(f => f.directory === directory)!.coordinator = coordinator; await coordinator.ready; },
  };
}
async function waitMessages(manager: SessionManager, count: number) { await expect.poll(() => manager.messages.length).toBe(count); }

it('starts manual work without recurring reviews and preserves normal work tools across restart', async () => {
  const f = await fixture();
  const work = await f.coordinator.create({ ...f.input, delegated: undefined }, 'manual');
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.[0]?.status).toBe('accepted');
  expect((await f.coordinator.get(work.id)).delegated).toBe(false);
  const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  await f.acknowledge(work);
  f.advance(60_000); await f.coordinator.tick();
  f.sessions.get('main')!.stream({ type: 'turn_completed', provider: 'codex' });
  await new Promise(resolve => setTimeout(resolve, 15));
  await f.coordinator.tick();
  expect(tpm.messages).toHaveLength(1);
  const todo = (await f.coordinator.get(work.id)).todo!;
  await f.call(work, 'update_todo_step', { revision: todo.revision, stepId: todo.steps[0]!.id, status: 'in_progress', note: 'User-led discussion' });
  await f.call(work, 'send_main_message', { operationId: 'manual-question', purpose: 'consultation', text: 'Explain feasibility.' });
  await expect.poll(() => f.sessions.get('main')!.messages.length).toBe(1);
  await f.restart(); f.advance(60_000); await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).delegated).toBe(false);
  expect(tpm.messages).toHaveLength(1);
});

it('stops future delegated reviews without interrupting an accepted review or its assessment', async () => {
  const f = await fixture(); const work = await f.create();
  await f.acknowledge(work); f.advance(2000); await f.coordinator.tick();
  const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  expect(tpm.messages).toHaveLength(2);
  const current = await f.coordinator.get(work.id);
  await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'stop-delegation', action: 'set_delegated', delegated: false }, 'user');
  expect(tpm.cancel).not.toHaveBeenCalled();
  await f.acknowledge(work, { summary: 'Current review finished normally' });
  f.advance(60_000); await f.coordinator.tick();
  expect(tpm.messages).toHaveLength(2);
  const manual = await f.coordinator.get(work.id);
  expect(manual.summary).toBe('Current review finished normally');
  await f.coordinator.action({ id: work.id, revision: manual.revision, operationId: 'delegate-again', action: 'set_delegated', delegated: true }, 'user');
  await expect.poll(() => tpm.messages.length).toBe(3);
});

it('binds main dispatch to the current todo and requires explicit user approval before implementation', async () => {
  const f = await fixture(); const work = await f.create();
  const tools = (await f.coordinator.extensions(work.providerId, work.tpmNativeSessionId!))!.tools!;
  const call = async (name: string, args: unknown) => JSON.parse(await tools.find(tool => tool.name === name)!.execute(args));
  let todo = await call('read_todo_list', {});
  const stepId = todo.steps[0].id;
  await expect(call('send_main_message', { operationId: 'early', purpose: 'implementation', text: 'Build now', todoStepId: stepId })).rejects.toThrow(/todo|approval|start/i);
  todo = await call('update_todo_step', { revision: todo.revision, stepId, status: 'in_progress', note: 'Discussing' });
  await expect(call('send_main_message', { operationId: 'early', purpose: 'implementation', text: 'Build now', todoStepId: stepId })).rejects.toThrow(/approval/i);
  todo = await call('complete_todo_step', { revision: todo.revision, stepId, evidence: ['Proposal written'] });
  const gateId = todo.steps.find((step: any) => step.status !== 'completed').id;
  todo = await call('request_todo_confirmation', { revision: todo.revision, stepId: gateId, content: 'Implement exact search.' });
  const current = await f.coordinator.get(work.id);
  const decision = { revision: todo.revision, stepId: gateId, requestId: todo.steps.find((step: any) => step.id === gateId).confirmation.id, decision: 'approve' as const };
  await f.coordinator.store.update(work.id, undefined, record => { record.work.nextCheckAt += 1; });
  const approved = await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'approve-plan', action: 'confirm_todo', confirmation: decision } as any, 'owner');
  expect(approved.todo?.steps.find(step => step.status !== 'completed')?.kind).toBe('task');
  expect((await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'approve-plan', action: 'confirm_todo', confirmation: decision } as any, 'owner')).todo).toEqual(approved.todo);
  await f.restart();
  expect((await f.coordinator.get(work.id)).todo).toEqual(approved.todo);
}, 10000);

it('rejects queued communication before native dispatch when its plan changed', async () => {
  const f = await fixture(); const work = await f.create(); const main = f.sessions.get('main')!;
  main.setStatus('running');
  const intent = await f.call(work, 'send_main_message', { operationId: 'old-plan', purpose: 'consultation', text: 'Discuss the original proposal' });
  const current = await f.coordinator.get(work.id);
  await f.call(work, 'write_work_document', { revision: current.revision, document: 'A revised proposal', acceptance: 'New criteria' });
  main.setStatus('idle'); await f.coordinator.tick();
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(item => item.id === intent.id)?.status).toBe('rejected');
  expect(main.messages).toEqual([]);
  expect((await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.resolvedTarget).toBeUndefined();
}, 10000);

it('starts and retains background review leases without browser or Relay connections', async () => {
  const f = await fixture(); const work = await f.create(); const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  expect(tpm.messages[0]?.text).toContain(f.input.requirement);
  expect(f.sessions.get('main')!.leases).toBe(1); expect(tpm.leases).toBe(1);
  expect(f.sessions.get('main')!.listeners.size).toBe(1); expect(tpm.listeners.size).toBe(1);
  await f.acknowledge(work); f.advance(1000); await f.coordinator.tick(); await waitMessages(tpm, 2);
  expect(tpm.messages[1]?.text).toContain('Heartbeat.');
}, 10000);

it('deduplicates concurrent creation and retries across restart and rejects identity reuse', async () => {
  const f = await fixture(); f.setAvailable(true);
  const [one, two] = await Promise.all([f.coordinator.create(f.input, 'scope'), f.coordinator.create(f.input, 'scope')]);
  expect(one.id).toBe(two.id); expect(f.creates).toHaveLength(1);
  await f.coordinator.close(); await f.restart();
  expect((await f.coordinator.create(f.input, 'scope')).id).toBe(one.id); expect(f.creates).toHaveLength(1);
  await expect(f.coordinator.create({ ...f.input, title: 'Different work' }, 'scope')).rejects.toThrow(/different input/);
}, 10000);

it('rejects providers lacking extension capabilities before acquiring or creating a native session', async () => {
  const f = await fixture(); f.setSupported([]);
  await expect(f.coordinator.create(f.input, 'scope')).rejects.toThrow(/support TPM/);
  expect(f.creates).toEqual([]); expect(f.sessions.get('main')!.leases).toBe(0); expect((await f.coordinator.list()).supported).toBe(false);
}, 10000);

it.each([true, false])('queues or defers normal main input while busy without cancel or steer (native queue=%s)', async queue => {
  const f = await fixture(queue); const work = await f.create(); const main = f.sessions.get('main')!; main.setStatus('running');
  await f.advanceTodo(work); await f.advanceTodo(work);
  const plan = (await f.coordinator.get(work.id)).todo!;
  await f.call(work, 'update_todo_step', { revision: plan.revision, stepId: 'implement', status: 'in_progress', note: 'Implementation approved' });
  const intent = await f.call(work, 'send_main_message', { operationId: 'main-message', purpose: 'implementation', text: 'Implement the agreed scope.' });
  if (queue) { await waitMessages(main, 1); expect(main.messages[0]?.options).toMatchObject({ delivery: 'next_turn' }); }
  else {
    await f.coordinator.tick(); await f.coordinator.store.flush(); expect(main.messages).toEqual([]);
    expect((await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.status).toBe('prepared');
    main.setStatus('idle'); await f.coordinator.tick(); await waitMessages(main, 1); expect((main.messages[0]?.options as AgentMessageOptions | undefined)?.delivery).toBeUndefined();
  }
  expect(main.messages[0]?.text).toContain(work.id); expect(main.cancel).not.toHaveBeenCalled(); expect(main.steer).not.toHaveBeenCalled();
  expect((await f.coordinator.get(work.id)).phase).toBe('clarifying');
}, 10000);

it('pause releases leases and preserves prepared communication until explicit resume', async () => {
  const f = await fixture(); let work = await f.create(); const main = f.sessions.get('main')!; main.setStatus('running');
  await f.call(work, 'send_main_message', { operationId: 'deferred', purpose: 'consultation', text: 'Assess feasibility.' });
  work = await f.coordinator.get(work.id); const request = { id: work.id, revision: work.revision, operationId: 'pause', action: 'pause' as const };
  const paused = await f.coordinator.action(request, 'scope'); expect(paused.paused).toBe(true);
  expect((await f.coordinator.action(request, 'scope')).revision).toBe(paused.revision);
  main.setStatus('idle'); f.advance(10000); await f.coordinator.tick(); expect(main.messages).toEqual([]); expect(main.leases).toBe(0);
  await f.coordinator.action({ id: work.id, revision: paused.revision, operationId: 'resume', action: 'resume' }, 'scope');
  await waitMessages(main, 1); expect((await f.coordinator.get(work.id)).paused).toBe(false);
}, 10000);

it('restores dispatching outcomes as unknown and never automatically replays or creates a replacement TPM', async () => {
  const f = await fixture(); const work = await f.create(); const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  await f.coordinator.close();
  await f.coordinator.store.update(work.id, undefined, record => { record.work.outbox![0]!.status = 'dispatching'; });
  await f.restart(); await f.coordinator.tick();
  const restored = await f.coordinator.get(work.id); expect(restored.outbox?.[0]?.status).toBe('unknown'); expect(restored.health).toMatch(/unknown/);
  f.advance(10000); await f.coordinator.tick(); expect(tpm.messages).toHaveLength(1); expect(f.creates).toHaveLength(1);
  await expect(f.coordinator.action({ id: work.id, revision: restored.revision, operationId: 'resume', action: 'resume' }, 'scope')).rejects.toThrow(/Resolve unknown/);
}, 10000);

it('retains uncertain native creation and retry does not create another TPM', async () => {
  const f = await fixture(); f.failCreate(new Error('Create receipt lost'));
  const work = await f.coordinator.create(f.input, 'scope'); expect(work.health).toBe('Create receipt lost');
  expect((await f.coordinator.create(f.input, 'scope')).id).toBe(work.id); expect(f.creates).toHaveLength(1);
  await f.restart(); expect((await f.coordinator.create(f.input, 'scope')).id).toBe(work.id); expect(f.creates).toHaveLength(1);
}, 10000);

it('requires work-specific acceptance evidence and stops completed work until explicitly reopened', async () => {
  const f = await fixture(); const work = await f.create();
  await expect(f.acknowledge(work, { phase: 'completed', acceptance: '', evidence: [] })).rejects.toThrow(/acceptance criteria/);
  await expect(f.acknowledge(work, { phase: 'completed', acceptance: 'All work criteria met', evidence: ['Evidence'] })).rejects.toThrow(/todo/i);
  let current = await f.coordinator.get(work.id);
  await f.call(work, 'write_work_document', { revision: current.revision, document: 'Accepted scope', acceptance: 'All work criteria met' });
  while (await f.advanceTodo(work)) { /* Advance each task and explicit user gate. */ }
  const completed = await f.acknowledge(work, { phase: 'completed', acceptance: 'All work criteria met', evidence: ['Main session turn verified passing checks'] });
  expect(completed.phase).toBe('completed'); expect(f.sessions.get('main')!.leases).toBe(0);
  f.advance(10000); await f.coordinator.tick(); expect(f.sessions.get(work.tpmNativeSessionId!)!.messages).toHaveLength(1);
  await expect(f.coordinator.action({ id: work.id, revision: completed.revision, operationId: 'check', action: 'check' }, 'scope')).rejects.toThrow(/Reopen/);
  await f.coordinator.action({ id: work.id, revision: completed.revision, operationId: 'reopen', action: 'reopen' }, 'scope');
  await waitMessages(f.sessions.get(work.tpmNativeSessionId!)!, 2); expect((await f.coordinator.get(work.id)).phase).toBe('clarifying');
}, 10000);

it('uses a longer user-waiting heartbeat and blocks review while a native interaction is pending', async () => {
  const f = await fixture(); const work = await f.create(); const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  const acknowledged = await f.acknowledge(work, { waiting: 'user' }); expect(acknowledged.nextCheckAt).toBe(f.now + 5000);
  f.advance(1000); await f.coordinator.tick(); expect(tpm.messages).toHaveLength(1);
  f.advance(4000); tpm.payload.pendingInteractions = [{ requestId: 'native-question' }]; await f.coordinator.tick(); expect(tpm.messages).toHaveLength(1);
  tpm.payload.pendingInteractions = []; await expect.poll(async () => { await f.coordinator.tick(); return tpm.messages.length; }).toBe(2);
}, 10000);

it('coalesces committed main content while ignoring history and usage-only updates', async () => {
  const f = await fixture(); const work = await f.create(); await f.acknowledge(work); const main = f.sessions.get('main')!; const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  f.advance(40);
  main.stream({ type: 'timeline', provider: 'codex', item: { id: 'old', type: 'assistant_message', text: 'Replayed history' } }, 'history');
  main.stream({ type: 'usage_updated', provider: 'codex', usage: { inputTokens: 10 } });
  await f.coordinator.tick(); expect(tpm.messages).toHaveLength(1);
  main.stream({ type: 'timeline', provider: 'codex', item: { id: 'answer', type: 'assistant_message', text: 'Work evidence' } });
  main.stream({ type: 'turn_completed', provider: 'codex', turnId: 'answer' });
  await expect.poll(async () => (await f.coordinator.get(work.id)).nextCheckAt).toBeLessThanOrEqual(f.now + 5);
  f.advance(5); await expect.poll(async () => { await f.coordinator.tick(); return tpm.messages.length; }).toBe(2);
  expect(tpm.messages[1]?.text).toContain('Main session updated.');
}, 10000);

it('validates scoped tool arguments and revision conflicts without exposing replacement targets or persistence', async () => {
  const f = await fixture(); const work = await f.create();
  await expect(f.call(work, 'send_main_message', { operationId: 'bad-target', purpose: 'consultation', text: 'Read', sessionId: 'different-session' })).rejects.toThrow(/Invalid arguments/);
  await expect(f.call(work, 'write_work_document', { revision: 0, document: 'Spec', acceptance: 'Criteria' })).rejects.toThrow(/Invalid arguments/);
  const current = await f.coordinator.get(work.id);
  await f.call(work, 'write_work_document', { revision: current.revision, document: 'Spec', acceptance: 'Criteria' });
  await expect(f.call(work, 'write_work_document', { revision: current.revision, document: 'Overwrite', acceptance: 'Criteria' })).rejects.toThrow(/changed/);
  const result = await f.call(work, 'read_main_session', { limit: 1 }); expect(result.state.persistence).toBeUndefined(); expect(result.state.runtimeInfo.persistence).toBeUndefined(); expect(result.page.nextCursor).toEqual({ epoch: 'epoch', seq: 1 });
  await expect(f.call(work, 'schedule_check', { seconds: 1, reason: 'Immediate' })).rejects.toThrow(/Invalid arguments/);
  const scheduled = await f.call(work, 'schedule_check', { seconds: 86400, reason: 'Check later' }); expect(scheduled.nextCheckAt).toBe(f.now + 1000);
}, 10000);

it('retains main changes arriving during an active review for a subsequent bounded review', async () => {
  const f = await fixture(); const work = await f.create(); const main = f.sessions.get('main')!; const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  main.stream({ type: 'timeline', provider: 'codex', item: { id: 'during-review', type: 'assistant_message', text: 'New evidence while TPM is reviewing' } });
  await expect.poll(async () => (await f.coordinator.get(work.id)).nextCheckAt).toBeLessThanOrEqual(f.now + 5);
  const acknowledged = await f.acknowledge(work); expect(acknowledged.nextCheckAt).toBe(f.now + 5);
  f.advance(5); await f.coordinator.tick(); expect(tpm.messages).toHaveLength(1);
  f.advance(25); await expect.poll(async () => { await f.coordinator.tick(); return tpm.messages.length; }).toBe(2);
  expect(tpm.messages[1]?.text).toContain('Main session updated.');
}, 10000);

it('limits automatic reviews to two and serves another work when a slot settles', async () => {
  const f = await fixture(); const one = await f.create('one'); const two = await f.create('two');
  const three = await f.coordinator.create({ ...f.input, operationId: 'three' }, 'browser-scope'); const third = f.sessions.get(three.tpmNativeSessionId!)!;
  await f.coordinator.tick(); await f.coordinator.store.flush();
  expect(f.sessions.get(one.tpmNativeSessionId!)!.messages).toHaveLength(1); expect(f.sessions.get(two.tpmNativeSessionId!)!.messages).toHaveLength(1);
  expect(third.messages).toEqual([]);
  await f.acknowledge(one); await expect.poll(async () => { await f.coordinator.tick(); return third.messages.length; }).toBe(1);
}, 10000);

it('releases an archived review slot without interrupting its running native session', async () => {
  const f = await fixture(); const one = await f.create('one'); await f.create('two');
  const three = await f.coordinator.create({ ...f.input, operationId: 'three' }, 'browser-scope');
  const third = f.sessions.get(three.tpmNativeSessionId!)!; const first = f.sessions.get(one.tpmNativeSessionId!)!;
  await f.coordinator.tick(); expect(third.messages).toEqual([]);
  const current = await f.coordinator.get(one.id);
  await f.coordinator.action({ id: one.id, revision: current.revision, operationId: 'archive-one', action: 'archive' }, 'owner');
  await expect.poll(async () => { await f.coordinator.tick(); return third.messages.length; }).toBe(1);
  expect(first.payload.status).toBe('running'); expect(first.cancel).not.toHaveBeenCalled(); expect(first.leases).toBe(0);
}, 10000);

it('pauses every affected work on native takeover and keeps bound session callbacks scoped', async () => {
  const f = await fixture(); const work = await f.create();
  await f.coordinator.handoff('codex', 'main'); const paused = await f.coordinator.get(work.id);
  expect(paused.paused).toBe(true); expect(paused.health).toContain('takeover'); expect(f.sessions.get('main')!.leases).toBe(0);
  await expect(f.call(work, 'send_main_message', { operationId: 'after-takeover', purpose: 'implementation', text: 'Continue' })).rejects.toThrow(/paused/);
  expect(await f.coordinator.extensions('codex', 'unrelated')).toBeUndefined();
  expect(await f.coordinator.extensions('copilot', work.tpmNativeSessionId!)).toBeUndefined();
}, 10000);

it('still pauses the main recipient when the TPM execution route is unavailable', async () => {
  const f = await fixture(); const work = await f.create();
  f.access.sessionRouting = { resolve() { throw new Error('No authorized current recipient'); }, assertCurrent() { throw new Error('Unavailable'); } };
  await f.coordinator.handoff('codex', 'unrelated');
  expect(f.coordinator.store.get(work.id).work.paused).toBe(false);
  await f.coordinator.handoff('codex', 'main');
  expect(f.coordinator.store.get(work.id).work.paused).toBe(true);
  expect(f.sessions.get('main')!.leases).toBe(0);
  expect(f.sessions.get(work.tpmNativeSessionId!)!.leases).toBe(0);
}, 10000);

it('resolves an explicitly rejected uncertain message without resending that message', async () => {
  const f = await fixture(); const work = await f.create(); const main = f.sessions.get('main')!; main.sendFailure = new Error('Receipt lost');
  const sent = await f.call(work, 'send_main_message', { operationId: 'uncertain-main', purpose: 'consultation', text: 'Investigate feasibility' });
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(value => value.id === sent.id)?.status).toBe('unknown');
  const current = await f.coordinator.get(work.id);
  await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'resolve-message', action: 'resolve', intentId: sent.id, resolution: 'rejected' }, 'scope');
  main.sendFailure = undefined; f.advance(10000); await f.coordinator.tick();
  expect(main.messages).toHaveLength(1); expect((await f.coordinator.get(work.id)).outbox?.find(value => value.id === sent.id)?.status).toBe('rejected');
}, 10000);

it('requires explicit native identity for lost creation and permits explicit abandonment without automatic retry', async () => {
  const f = await fixture(); f.failCreate(new Error('Lost creation receipt')); const work = await f.coordinator.create(f.input, 'scope');
  await expect(f.coordinator.action({ id: work.id, revision: work.revision, operationId: 'resolve-no-identity', action: 'resolve', intentId: 'creation', resolution: 'accepted' }, 'scope')).rejects.toThrow(/native session identity/);
  const abandoned = await f.coordinator.action({ id: work.id, revision: work.revision, operationId: 'abandon-creation', action: 'resolve', intentId: 'creation', resolution: 'rejected' }, 'scope');
  expect(abandoned.paused).toBe(true); expect(abandoned.creationStatus).toBe('abandoned');
  await expect(f.coordinator.action({ id: work.id, revision: abandoned.revision, operationId: 'resume-abandoned', action: 'resume' }, 'scope')).rejects.toThrow(/abandoned/);
  f.advance(10000); await f.coordinator.tick(); expect(f.creates).toHaveLength(1);
}, 10000);

it('rechecks pause immediately before native dispatch and settles a deferred request as rejected', async () => {
  const f = await fixture(); const work = await f.create(); const main = f.sessions.get('main')!;
  let entered = false; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.access.execute = async (_agent, _operation, operation) => { entered = true; await barrier; operation.beforeDispatch?.(); return operation.dispatch(); };
  const intent = await f.call(work, 'send_main_message', { operationId: 'pause-race', purpose: 'consultation', text: 'Investigate' });
  await expect.poll(() => entered).toBe(true);
  const current = await f.coordinator.get(work.id);
  await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'pause-race-action', action: 'pause' }, 'scope'); release();
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.status).toBe('rejected');
  expect(main.messages).toEqual([]); expect((await f.coordinator.get(work.id)).paused).toBe(true);
  expect((await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.resolvedTarget).toBeUndefined();
}, 10000);

it('ignores a known outgoing message echo instead of treating it as independent work evidence', async () => {
  const f = await fixture(); const work = await f.create(); const main = f.sessions.get('main')!; const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  const intent = await f.call(work, 'send_main_message', { operationId: 'known-message', purpose: 'consultation', text: 'Investigate' }); await waitMessages(main, 1);
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.status).toBe('accepted');
  main.setStatus('idle'); await f.acknowledge(work); f.advance(40);
  main.stream({ type: 'timeline', provider: 'codex', item: { id: 'echo', type: 'user_message', clientMessageId: intent.id, text: 'Investigate' } });
  await f.coordinator.tick(); await f.coordinator.store.flush(); expect(tpm.messages).toHaveLength(1);
  expect((await f.coordinator.get(work.id)).nextCheckAt).toBe(1_001_000);
}, 10000);

it.each(['started', 'queued', 'handled', undefined] as const)('preserves native input acceptance without claiming delivery completion (%s)', async disposition => {
  const f = await fixture(disposition === 'queued'); const work = await f.create(); const main = f.sessions.get('main')!;
  main.sendMessage = async (text, options) => { main.messages.push({ text, options }); return disposition === undefined ? undefined as any : { disposition }; };
  const intent = await f.call(work, 'send_main_message', { operationId: `acceptance-${disposition ?? 'unknown'}`, purpose: 'consultation', text: 'Inspect feasibility' });
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.status).toBe('accepted');
  const current = await f.coordinator.get(work.id); const settled = current.outbox?.find(value => value.id === intent.id);
  expect(settled?.acceptance).toBe(disposition); expect(current.phase).toBe('clarifying');
}, 10000);

it('starts an unspecified TPM conversation and persists its name after clarification', async () => {
  const f = await fixture();
  const input = { providerId: 'codex', mainNativeSessionId: 'main', operationId: 'blank-session' };
  const created = await f.coordinator.create(input, 'browser-scope');
  expect(created).toMatchObject({ title: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+$/), phase: 'clarifying', waiting: 'user', summary: '', document: '' });
  const native = f.sessions.get(created.tpmNativeSessionId!)!;
  await waitMessages(native, 1);
  expect(native.messages[0]!.text).toContain('No requirement has been provided yet');
  expect(f.sessions.get('main')!.messages).toEqual([]);
  const duplicate = await f.coordinator.create(input, 'browser-scope');
  expect(duplicate.id).toBe(created.id);
  expect(f.creates).toHaveLength(1);
  await expect.poll(async () => (await f.coordinator.get(created.id)).outbox?.[0]?.status).toBe('accepted');
  const current = await f.coordinator.get(created.id);
  await f.call(current, 'update_work', { revision: current.revision, title: 'Improve session search', phase: 'clarifying', waiting: 'user', summary: 'Discussing search scope', nextAction: 'Agree on acceptance criteria' });
  expect((await f.coordinator.list()).works[0]!.title).toBe('Improve session search');
  await f.restart();
  expect((await f.coordinator.get(created.id)).title).toBe('Improve session search');
});

it('preserves manual names across model updates, retries and restart', async () => {
  const f = await fixture(); const work = await f.create();
  const rename = { id: work.id, revision: work.revision, operationId: 'rename-one', action: 'rename' as const, title: '  Mobile reconnect  ' };
  const renamed = await f.coordinator.action(rename, 'owner');
  expect(renamed.title).toBe('Mobile reconnect');
  expect(renamed.phase).toBe(work.phase);
  expect((await f.coordinator.action(rename, 'owner')).revision).toBe(renamed.revision);
  await expect(f.coordinator.action({ ...rename, operationId: 'stale', title: 'Stale name' }, 'owner')).rejects.toThrow('changed');
  await f.call(renamed, 'update_work', { revision: renamed.revision, title: 'Model suggestion', phase: 'clarifying', waiting: 'user', summary: 'Scope discussed', nextAction: 'Wait for input' });
  expect((await f.coordinator.get(work.id)).title).toBe('Mobile reconnect');
  await f.restart();
  const restored = await f.coordinator.get(work.id);
  expect(restored.title).toBe('Mobile reconnect');
  expect((await f.call(restored, 'read_work', {})).titleSetByUser).toBe(true);
});
it('archives completed work, retaining the conversation and allowing restore or reopen', async () => {
  const f = await fixture(); const work = await f.create();
  await f.call(work, 'write_work_document', { revision: work.revision, document: 'Accepted scope', acceptance: 'Verified' });
  while (await f.advanceTodo(work)) { /* Complete all tasks and explicit user confirmations. */ }
  const completed = await f.acknowledge(work, { phase: 'completed', acceptance: 'Verified', evidence: ['Checks passed'] });
  const input = { id: work.id, revision: completed.revision, operationId: 'archive', action: 'archive' as const };
  const archived = await f.coordinator.action(input, 'owner');
  expect(archived).toMatchObject({ archived: true, phase: 'completed', tpmNativeSessionId: work.tpmNativeSessionId, evidence: ['Checks passed'] });
  expect((await f.coordinator.action(input, 'owner')).revision).toBe(archived.revision);
  await f.restart();
  expect((await f.coordinator.list()).works[0]).toMatchObject({ archived: true, id: work.id });
  const restored = await f.coordinator.action({ id: work.id, revision: archived.revision, operationId: 'restore', action: 'unarchive' }, 'owner');
  expect(restored).toMatchObject({ archived: false, phase: 'completed' });
  const again = await f.coordinator.action({ id: work.id, revision: restored.revision, operationId: 'archive-again', action: 'archive' }, 'owner');
  const reopened = await f.coordinator.action({ id: work.id, revision: again.revision, operationId: 'reopen', action: 'reopen' }, 'owner');
  expect(reopened).toMatchObject({ archived: false, phase: 'clarifying' });
});

it('archives unfinished work immediately and never resumes its unsent messages on restore', async () => {
  const f = await fixture(); let work = await f.create(); const main = f.sessions.get('main')!; const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  main.setStatus('running');
  const pending = await f.call(work, 'send_main_message', { operationId: 'unsent', purpose: 'consultation', text: 'An obsolete question' });
  work = await f.coordinator.get(work.id);
  const archived = await f.coordinator.action({ id: work.id, revision: work.revision, operationId: 'stop', action: 'archive' }, 'owner');
  expect(archived).toMatchObject({ archived: true, paused: true, phase: work.phase, todo: work.todo, summary: work.summary });
  expect(archived.outbox?.find(intent => intent.id === pending.id)).toMatchObject({ status: 'rejected', error: expect.stringMatching(/archived.*dispatch/i) });
  expect(main.leases).toBe(0); expect(tpm.leases).toBe(0);
  await expect(f.call(archived, 'update_work', { revision: archived.revision, phase: 'implementing', waiting: 'none', summary: 'Late review', nextAction: 'Keep working' })).rejects.toThrow(/archived/i);
  main.setStatus('idle'); tpm.setStatus('idle'); await f.restart(); f.advance(10000); await f.coordinator.tick();
  expect(main.messages).toEqual([]); expect(tpm.messages).toHaveLength(1);
  const current = await f.coordinator.get(work.id);
  await expect(f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'resume-archived', action: 'resume' }, 'owner')).rejects.toThrow(/unarchive|restore/i);
  const restored = await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'restore', action: 'unarchive' }, 'owner');
  expect(restored).toMatchObject({ archived: false, paused: true, phase: work.phase });
  await f.coordinator.tick(); expect(tpm.messages).toHaveLength(1);
  await f.coordinator.action({ id: work.id, revision: restored.revision, operationId: 'resume', action: 'resume' }, 'owner');
  await waitMessages(tpm, 2); expect(main.messages).toEqual([]);
}, 10000);

it.each([false, true])('archive settles only known pre-dispatch rejection and preserves uncertain native execution (dispatched=%s)', async dispatched => {
  const f = await fixture(); const work = await f.create(); const main = f.sessions.get('main')!;
  let entered = false; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.access.execute = async (_agent, _operation, operation) => {
    if (dispatched) { operation.beforeDispatch?.(); await operation.dispatch(); }
    entered = true; await barrier;
    if (dispatched) throw new Error('Native receipt lost after archive');
    operation.beforeDispatch?.(); return operation.dispatch();
  };
  const intent = await f.call(work, 'send_main_message', { operationId: 'archive-race', purpose: 'consultation', text: 'Inspect feasibility' });
  try {
    await expect.poll(() => entered).toBe(true);
    const current = await f.coordinator.get(work.id);
    const archived = await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'stop-race', action: 'archive' }, 'owner');
    expect(archived.outbox?.find(value => value.id === intent.id)?.status).toBe(dispatched ? 'dispatching' : 'rejected');
    expect(archived.outbox?.find(value => value.id === intent.id)?.resolvedTarget).toEqual(dispatched ? { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'main' } : undefined);
  } finally { release(); }
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.status).toBe(dispatched ? 'unknown' : 'rejected');
  expect(main.messages).toHaveLength(dispatched ? 1 : 0);
  expect(main.cancel).not.toHaveBeenCalled();
  await f.restart(); f.advance(10000); await f.coordinator.tick();
  expect((await f.coordinator.get(work.id))).toMatchObject({ archived: true, paused: true, phase: work.phase });
  expect(main.messages).toHaveLength(dispatched ? 1 : 0);
}, 10000);

it('lets the TPM explicitly complete delivery only after every task and user confirmation', async () => {
  const f = await fixture(); const work = await f.create();
  const complete = async () => f.call(work, 'complete_work', { revision: (await f.coordinator.get(work.id)).revision, summary: 'Delivered the agreed result', evidence: ['Verified acceptance evidence'] });
  await expect(complete()).rejects.toThrow(/acceptance criteria/i);
  await f.call(work, 'write_work_document', { revision: (await f.coordinator.get(work.id)).revision, document: 'Agreed scope', acceptance: 'Verified result' });
  await f.advanceTodo(work);
  await expect(complete()).rejects.toThrow(/todo/i);
  expect((await f.coordinator.get(work.id)).todo!.steps.find(step => step.status !== 'completed')?.kind).toBe('confirmation');
  while (await f.advanceTodo(work)) { /* Each user gate requires an explicit decision. */ }
  const completed = await complete();
  expect(completed).toMatchObject({ phase: 'completed', waiting: 'none', nextAction: '', summary: 'Delivered the agreed result' });
  expect(f.sessions.get('main')!.leases).toBe(0);
  f.sessions.get(work.tpmNativeSessionId!)!.setStatus('idle');
  f.advance(10000); await f.coordinator.tick();
  expect(f.sessions.get(work.tpmNativeSessionId!)!.messages).toHaveLength(1);
  await f.restart(); await f.coordinator.tick();
  expect(f.sessions.get(work.tpmNativeSessionId!)!.messages).toHaveLength(1);
}, 10000);

function successionRouting(f: Awaited<ReturnType<typeof fixture>>) {
  const origin = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'main' };
  let target = origin; let revision = 1;
  const acquired: Array<{ providerId: string; nativeSessionId: string }> = [];
  f.access.mainRouting = {
    async bind() { return { kind: 'primary_role', roleId: 'primary', origin }; },
    resolve() { return { target, roleRevision: revision }; },
    async acquire(ref) { acquired.push(ref); return f.access.acquire(ref.providerId, ref.nativeSessionId); },
    assertCurrent(_binding, ref, roleRevision) {
      if (JSON.stringify(ref) !== JSON.stringify(target) || roleRevision !== revision) throw new Error('Primary role changed.');
    },
  };
  return { acquired, origin, get target() { return target; },
    commit(id: string, providerId = 'other') { target = { ...origin, providerId, nativeSessionId: id }; revision++; f.sessions.set(id, new SessionManager(id)); },
  };
}

it('follows succession for every work and subscription while preserving paused work and TPM identities', async () => {
  const f = await fixture(); const route = successionRouting(f);
  const one = await f.create(); const two = await f.create('create-two');
  const paused = await f.coordinator.action({ id: two.id, revision: (await f.coordinator.get(two.id)).revision, operationId: 'pause-two', action: 'pause' }, 'owner');
  route.commit('successor'); await f.coordinator.tick();
  const works = await f.coordinator.list();
  for (const work of works.works) {
    expect(work.mainNativeSessionId).toBe('successor');
    expect(work.mainSessionRef).toEqual(route.target);
    expect(work.mainBinding).toEqual({ kind: 'primary_role', roleId: 'primary', origin: route.origin });
    expect(work.providerId).toBe('codex');
  }
  expect((await f.coordinator.get(two.id)).todo).toEqual(paused.todo);
  expect((await f.coordinator.get(two.id)).paused).toBe(true);
  expect((await f.coordinator.get(one.id)).tpmNativeSessionId).toBe(one.tpmNativeSessionId);
  expect((await f.coordinator.get(one.id)).outbox![0]!.resolvedTarget).toEqual({ ...route.origin, nativeSessionId: one.tpmNativeSessionId });
  expect(f.sessions.get('main')!.leases).toBe(0);
  expect(f.sessions.get('main')!.listeners.size).toBe(0);
  expect(f.sessions.get('successor')!.listeners.size).toBe(1);
  f.access.mainRouting!.read = async binding => {
    const resolved = f.access.mainRouting!.resolve(binding); const lease = await f.access.mainRouting!.acquire(resolved.target);
    try { return { state: lease.agent.snapshot().payload, sourceRef: resolved.target }; } finally { lease.release(); }
  };
  const read = await f.call(one, 'read_main_session', {});
  expect(read.state.id).toBe('successor');
  expect(route.acquired.at(-1)).toEqual(route.target);
}, 10000);

it('admits a prepared main intent once to the successor and durably pins the full recipient', async () => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  f.sessions.get('main')!.setStatus('running');
  const intent = await f.call(work, 'send_main_message', { operationId: 'prepared-before-succession', purpose: 'consultation', text: 'Assess the scope' });
  await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).outbox?.find(item => item.id === intent.id)?.status).toBe('prepared');
  route.commit('successor'); await f.coordinator.tick();
  await waitMessages(f.sessions.get('successor')!, 1);
  const admitted = (await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!;
  expect(admitted).toMatchObject({ status: 'accepted', resolvedTarget: route.target, roleRevision: 2 });
  expect(f.sessions.get('main')!.messages).toEqual([]);
  route.commit('third'); await f.coordinator.tick(); await f.restart(); await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!.resolvedTarget).toEqual(admitted.resolvedTarget);
  expect(f.sessions.get('third')!.messages).toEqual([]);
}, 10000);

it.each(['dispatching', 'unknown', 'accepted', 'queued'] as const)('never retargets %s main delivery after succession and restart', async status => {
  const f = await fixture(true); const route = successionRouting(f); const work = await f.create();
  const intent = await f.call(work, 'send_main_message', { operationId: 'pinned', purpose: 'consultation', text: 'Assess once' });
  await waitMessages(f.sessions.get('main')!, 1);
  await f.coordinator.close();
  await f.coordinator.store.update(work.id, undefined, record => {
    const item = record.work.outbox!.find(value => value.id === intent.id)!;
    item.status = status === 'queued' ? 'accepted' : status;
    if (status === 'queued') item.acceptance = 'queued';
  });
  route.commit('successor'); await f.restart(); await f.coordinator.tick();
  const restored = (await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!;
  expect(restored.resolvedTarget).toEqual(route.origin); expect(restored.roleRevision).toBe(1);
  expect(restored.status).toBe(status === 'dispatching' ? 'unknown' : status === 'queued' ? 'accepted' : status);
  await f.call(work, 'send_main_message', { operationId: 'pinned', purpose: 'consultation', text: 'Assess once' });
  expect(f.sessions.get('successor')!.messages).toEqual([]);
  expect(f.sessions.get('main')!.messages).toHaveLength(1);
}, 10000);

it('rejects a claimed intent when succession commits before final native dispatch without replaying it', async () => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  const original = f.access.execute;
  f.access.execute = async (agent, operation, execution) => {
    if (agent.agentId === 'main') {
      const originalUpdate = f.coordinator.store.update.bind(f.coordinator.store);
      f.coordinator.store.update = async (...args) => {
        const value = await originalUpdate(...args);
        if (!value.work.outbox?.some(item => item.target === 'main' && item.status === 'dispatching')) return value;
        const persisted = (await f.coordinator.get(work.id)).outbox!.find(item => item.target === 'main' && item.status === 'dispatching')!;
        expect(persisted).toMatchObject({ status: 'dispatching', resolvedTarget: route.origin, roleRevision: 1 });
        route.commit('successor'); f.coordinator.store.update = originalUpdate; return value;
      };
    }
    return original(agent, operation, execution);
  };
  const intent = await f.call(work, 'send_main_message', { operationId: 'commit-race', purpose: 'consultation', text: 'Check once' });
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(item => item.id === intent.id)?.status).toBe('rejected');
  expect(f.sessions.get('main')!.messages).toEqual([]); expect(f.sessions.get('successor')!.messages).toEqual([]);
  await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!.resolvedTarget).toEqual(route.origin);
}, 10000);

it('enrolls existing fixed and legacy paused works when their main acquires a role', async () => {
  const f = await fixture(); const route = successionRouting(f);
  const bind = f.access.mainRouting!.bind;
  f.access.mainRouting!.bind = async () => ({ kind: 'fixed', source: route.origin });
  const work = await f.create();
  const intent = await f.call(work, 'send_main_message', { operationId: 'before-role', purpose: 'consultation', text: 'Old receipt' });
  await waitMessages(f.sessions.get('main')!, 1);
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)?.status).toBe('accepted');
  await f.coordinator.action({ id: work.id, revision: (await f.coordinator.get(work.id)).revision, operationId: 'pause', action: 'pause' }, 'owner');
  f.access.mainRouting!.bind = bind; route.commit('successor'); await f.coordinator.tick();
  const current = await f.coordinator.get(work.id);
  expect(current.mainBinding?.kind).toBe('primary_role'); expect(current.paused).toBe(true);
  expect(current.outbox!.find(item => item.id === intent.id)!.resolvedTarget).toEqual(route.origin);
  expect(f.sessions.get('successor')!.messages).toEqual([]);
}, 10000);

it('reports uncertain and queued main recipients to readiness using their pinned addresses', async () => {
  const f = await fixture(true); const route = successionRouting(f); const work = await f.create();
  const intent = await f.call(work, 'send_main_message', { operationId: 'queued-readiness', purpose: 'consultation', text: 'Assess once' });
  await waitMessages(f.sessions.get('main')!, 1);
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true);
  route.commit('successor'); await f.coordinator.tick();
  expect(f.coordinator.hasUnsettledRecipient(route.target)).toBe(false);
  for (const acceptance of [undefined, 'queued', 'started', 'handled'] as const) {
    await f.coordinator.store.update(work.id, undefined, record => { const item = record.work.outbox!.find(item => item.id === intent.id)!; item.status = 'accepted'; item.acceptance = acceptance; });
    expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(acceptance === undefined || acceptance === 'queued');
    expect(f.coordinator.hasUnsettledRecipient(route.target)).toBe(false);
    const summary = (await f.coordinator.list()).works.find(item => item.id === work.id)!;
    expect(summary.outbox?.some(item => item.id === intent.id)).toBe(acceptance === undefined || acceptance === 'queued');
  }
  for (const status of ['prepared', 'dispatching', 'unknown'] as const) {
    await f.coordinator.store.update(work.id, undefined, record => { record.work.outbox!.find(item => item.id === intent.id)!.status = status; });
    expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(status !== 'prepared');
    const summary = (await f.coordinator.list()).works.find(item => item.id === work.id)!;
    expect(summary.outbox?.some(item => item.id === intent.id)).toBe(true);
  }
  await f.coordinator.store.update(work.id, undefined, record => { record.work.outbox!.find(item => item.id === intent.id)!.status = 'rejected'; });
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(false);
  expect((await f.coordinator.list()).works.find(item => item.id === work.id)!.outbox?.some(item => item.id === intent.id)).toBe(false);
}, 10000);

it('requires the contextual reader after succession and passes signed source cursors without native reinterpretation', async () => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  route.commit('successor');
  await expect(f.call(work, 'read_main_session', {})).rejects.toThrow(/contextual|context.*read/i);
  const queries: Record<string, unknown>[] = [];
  f.access.mainRouting!.read = async (_binding, input) => {
    queries.push(input);
    return { sourceRef: route.origin, sourceRoleRevision: 1, sourceRepresentation: 'pending_context', entries: [{ text: 'Captured predecessor history' }], cursor: 'signed-next', sourceContext: 'signed-source' };
  };
  const input = { cursor: 'signed-old', sourceContext: 'signed-source', turnId: 'turn', textOffset: 10, limit: 5 };
  const page = await f.call(work, 'read_main_session', input);
  expect(queries).toEqual([input]); expect(page.sourceRef).toEqual(route.origin);
  expect(page.entries[0].text).toBe('Captured predecessor history');
  expect(f.sessions.get('successor')!.messages).toEqual([]);
}, 10000);

it('pins legacy unknown receipts before enrolling a work whose main already succeeded', async () => {
  const f = await fixture(true); const work = await f.create();
  const intent = await f.call(work, 'send_main_message', { operationId: 'legacy-unknown', purpose: 'consultation', text: 'Legacy uncertain delivery' });
  await waitMessages(f.sessions.get('main')!, 1); await f.coordinator.close();
  await f.coordinator.store.update(work.id, undefined, record => { record.work.outbox!.find(item => item.id === intent.id)!.status = 'unknown'; });
  const route = successionRouting(f); route.commit('successor'); await f.restart(); await f.coordinator.tick();
  const restored = (await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!;
  expect(restored.resolvedTarget).toEqual(route.origin);
  expect(restored.roleRevision).toBeUndefined();
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true); expect(f.coordinator.hasUnsettledRecipient(route.target)).toBe(false);
  expect(f.sessions.get('successor')!.messages).toEqual([]);
}, 10000);

it('pauses automation on takeover of the current cross-provider main but not its historical predecessor', async () => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  route.commit('successor'); await f.coordinator.tick();
  await f.coordinator.handoff('codex', 'main'); expect((await f.coordinator.get(work.id)).paused).toBe(false);
  await f.coordinator.handoff('other', 'successor'); expect((await f.coordinator.get(work.id)).paused).toBe(true);
  expect(f.sessions.get('successor')!.leases).toBe(0);
}, 10000);

it('retains queued evidence when enqueue reaches the intent count limit', async () => {
  const f = await fixture(true); const route = successionRouting(f); const work = await f.create();
  const intent = await f.call(work, 'send_main_message', { operationId: 'queued-limit', purpose: 'consultation', text: 'Keep queued recipient' });
  await waitMessages(f.sessions.get('main')!, 1);
  await f.coordinator.store.update(work.id, undefined, record => {
    const queued = record.work.outbox!.find(item => item.id === intent.id)!;
    record.work.outbox = [queued, ...Array.from({ length: 199 }, (_, i) => ({ ...queued, id: `settled-${i}`, acceptance: 'started' as const }))];
  });
  await f.call(work, 'send_main_message', { operationId: 'new-at-limit', purpose: 'consultation', text: 'Another request' });
  expect((await f.coordinator.get(work.id)).outbox!.some(item => item.id === intent.id)).toBe(true);
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true);
}, 10000);

it.each(['bind', 'resolve'] as const)('isolates a failed role %s and retries it while another work continues background scheduling', async failure => {
  const f = await fixture(); successionRouting(f); const bad = await f.create(); const good = await f.create('good-work');
  await f.acknowledge(bad); await f.acknowledge(good);
  await f.coordinator.store.update(bad.id, undefined, record => {
    record.work.mainBinding = failure === 'bind' ? { kind: 'fixed', source: { ...record.work.mainSessionRef!, nativeSessionId: 'bad-origin' } }
      : { ...record.work.mainBinding!, kind: 'primary_role', roleId: 'missing-role' } as any;
  });
  const original = f.access.mainRouting!.resolve; const bind = f.access.mainRouting!.bind; let broken = true; let failures = 0;
  f.access.mainRouting!.bind = async (providerId, nativeSessionId) => {
    if (broken && nativeSessionId === 'bad-origin') { failures++; throw new Error('Primary role unavailable'); }
    return bind(providerId, nativeSessionId);
  };
  f.access.mainRouting!.resolve = binding => {
    if (broken && binding.kind === 'primary_role' && binding.roleId === 'missing-role') { failures++; throw new Error('Primary role unavailable'); }
    return original(binding);
  };
  f.advance(1000); await f.coordinator.tick();
  await waitMessages(f.sessions.get(good.tpmNativeSessionId!)!, 2);
  const listed = await f.coordinator.list();
  expect(listed.works.find(work => work.id === bad.id)?.health).toContain('Primary role unavailable');
  expect((await f.coordinator.get(bad.id)).health).toContain('Primary role unavailable');
  const attempts = failures; await f.coordinator.tick(); expect(failures).toBe(attempts);
  broken = false; f.advance(30_001); await f.coordinator.tick();
  await waitMessages(f.sessions.get(bad.tpmNativeSessionId!)!, 2);
}, 10000);

it('surfaces background scheduler rejection and recovers on a later timer tick', async () => {
  const f = await fixture(false, 30); const work = await f.create();
  const available = f.access.available; let failure = true;
  f.access.available = () => { if (failure) throw new Error('Availability probe failed'); return available(); };
  await expect.poll(async () => (await f.coordinator.get(work.id)).health, { interval: 5 }).toContain('Background TPM scheduling failed: Availability probe failed');
  failure = false;
  await expect.poll(async () => (await f.coordinator.get(work.id)).health, { interval: 5 }).toBeUndefined();
}, 10000);

it('uses stable UUID execution identities while retaining tool receipts across work scope and restart', async () => {
  const f = await fixture(true); const operations: Array<{agentId:string;operationId:string}> = [];
  const execute = f.access.execute;
  f.access.execute = async (agent, operation, work) => { operations.push({agentId:agent.agentId,operationId:operation.operationId}); return execute(agent, operation, work); };
  const one = await f.create(); const two = await f.create('second-work');
  expect(operations.find(operation => operation.agentId === one.tpmNativeSessionId)?.operationId).toBe(one.outbox![0]!.id);
  const input = { operationId: 'same-tool-id', purpose: 'consultation', text: 'Assess this scope' };
  const first = await f.call(one, 'send_main_message', input);
  await waitMessages(f.sessions.get('main')!, 1);
  const second = await f.call(two, 'send_main_message', input);
  await waitMessages(f.sessions.get('main')!, 2);
  const third = await f.call(one, 'send_main_message', { ...input, operationId: 'another-tool-id' });
  await waitMessages(f.sessions.get('main')!, 3);
  const executionIds = operations.filter(operation => operation.agentId === 'main').map(operation => operation.operationId);
  expect(executionIds).toHaveLength(3);
  for (const id of executionIds) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(executionIds).size).toBe(3);
  expect(new Set([first.id,second.id,third.id]).size).toBe(3);
  await expect(f.call(one, 'send_main_message', { ...input, text: 'Conflicting content' })).rejects.toThrow(/different content/);
  await f.restart();
  expect(await f.call(one, 'send_main_message', input)).toMatchObject({id:first.id,status:'accepted'});
  expect(await f.call(two, 'send_main_message', input)).toMatchObject({id:second.id,status:'accepted'});
  expect(operations.filter(operation => operation.agentId === 'main').map(operation => operation.operationId)).toEqual(executionIds);
  expect(f.sessions.get('main')!.messages).toHaveLength(3);
}, 10000);

it.each([true, false])('publishes the initial intent with native creation before a scheduler tick (requirement=%s)', async (hasRequirement) => {
  const f = await fixture(); const update = f.coordinator.store.update.bind(f.coordinator.store);
  let scheduled = false;
  f.coordinator.store.update = async (...args) => {
    const record = await update(...args);
    if (!scheduled && record.creation === 'accepted' && record.work.tpmNativeSessionId) {
      scheduled = true;
      await f.coordinator.tick();
    }
    return record;
  };
  const work = await f.coordinator.create({ ...f.input, requirement: hasRequirement ? f.input.requirement : undefined }, 'browser-scope');
  const messages = f.sessions.get(work.tpmNativeSessionId!)!.messages;
  expect(scheduled).toBe(true);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.text).toContain(hasRequirement ? f.input.requirement : 'No requirement has been provided yet.');
  const current = await f.coordinator.get(work.id);
  expect(current.outbox).toEqual([expect.objectContaining({ purpose: 'initial', status: 'accepted' })]);
  expect(f.sessions.get('main')!.messages).toEqual([]);
}, 10000);


it.each(['void', 'unknown', 'queued'] as const)('settles the original main intent after late acceptance following %s', async outcome => {
  const f = await fixture(outcome === 'queued'); const route = successionRouting(f); const work = await f.create();
  const main = f.sessions.get('main')!; let notify: AgentMessageOptions['onAcceptance'];
  main.sendMessage = (async (text: string, options?: AgentMessageOptions) => {
    main.messages.push({ text, options }); notify = options?.onAcceptance;
    if (outcome === 'unknown') throw new Error('Native acknowledgement lost');
    return outcome === 'queued' ? { disposition: 'queued' } : undefined;
  }) as typeof main.sendMessage;
  const execute = f.access.execute;
  f.access.execute = (agent, operation, execution) => {
    if (agent.agentId === 'main') expect(operation.parameters).toEqual({ text: expect.any(String), ...(outcome === 'queued' ? { options: { delivery: 'next_turn' } } : {}) });
    return execute(agent, operation, execution);
  };
  const receipt = await f.call(work, 'send_main_message', { operationId: `late-${outcome}`, purpose: 'consultation', text: 'Assess once' });
  await f.coordinator.tick();
  const current = (await f.coordinator.get(work.id)).outbox!.find(item => item.id === receipt.id)!;
  expect(current.status).toBe(outcome === 'unknown' ? 'unknown' : 'accepted');
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true);
  expect(notify).toBeTypeOf('function');
  notify!({ disposition: 'queued' }); await f.coordinator.store.flush();
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true);
  notify!({ disposition: 'started' });
  await expect.poll(() => f.coordinator.hasUnsettledRecipient(route.origin)).toBe(false);
  const confirmed = await f.coordinator.get(work.id);
  expect(confirmed.outbox!.find(item => item.id === receipt.id)).toMatchObject({ status: 'accepted', acceptance: 'started', resolvedTarget: route.origin, roleRevision: 1 });
  expect(confirmed.outbox!.find(item => item.id === receipt.id)!.error).toBeUndefined();
  notify!({ disposition: 'started' }); notify!({ disposition: 'queued' });
  await new Promise<void>(resolve => setImmediate(resolve)); await f.coordinator.store.flush();
  expect(f.coordinator.store.get(work.id).work.revision).toBe(confirmed.revision);
  await f.coordinator.close();
  await f.restart(); await f.coordinator.tick();
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(false);
  expect(main.messages).toHaveLength(1);
}, 10000);

it.each(['void', 'queued', 'unknown', 'rejected'] as const)('preserves acceptance that precedes the %s response', async outcome => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  const main = f.sessions.get('main')!;
  main.sendMessage = (async (text: string, options?: AgentMessageOptions) => {
    main.messages.push({ text, options }); options?.onAcceptance?.({ disposition: 'handled' });
    if (outcome === 'unknown') throw new Error('Response lost after native acceptance');
    if (outcome === 'rejected') throw new AgentOperationRejectedError('native_rejected', 'Late rejection');
    return outcome === 'queued' ? { disposition: 'queued' } : undefined;
  }) as typeof main.sendMessage;
  const receipt = await f.call(work, 'send_main_message', { operationId: `early-${outcome}`, purpose: 'consultation', text: 'Assess once' });
  await f.coordinator.tick();
  const intent = (await f.coordinator.get(work.id)).outbox!.find(item => item.id === receipt.id)!;
  expect(intent).toMatchObject({ status: 'accepted', acceptance: 'handled', resolvedTarget: route.origin, roleRevision: 1 });
  expect(intent.error).toBeUndefined();
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(false); expect(main.messages).toHaveLength(1);
}, 10000);

it('rejects a queued main follow-up withdrawn by stopping the recipient and releases the recipient', async () => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  const main = f.sessions.get('main')!; let options: AgentMessageOptions | undefined;
  main.sendMessage = (async (text: string, value?: AgentMessageOptions) => {
    main.messages.push({ text, options: value }); options = value; return { disposition: 'queued' };
  }) as typeof main.sendMessage;
  const receipt = await f.call(work, 'send_main_message', { operationId: 'withdrawn', purpose: 'consultation', text: 'Assess once' });
  await f.coordinator.tick();
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true);
  options!.onWithdrawn!({ reason: 'stopped' });
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox!.find(item => item.id === receipt.id)?.status).toBe('rejected');
  expect((await f.coordinator.get(work.id)).outbox!.find(item => item.id === receipt.id)!.error).toMatch(/stopped before this follow-up ran/);
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(false);
  expect(main.messages).toHaveLength(1);
}, 10000);

it.each(['unknown', 'void'] as const)('does not manufacture acceptance after coordinator replacement with %s outcome', async outcome => {
  const f = await fixture(); const route = successionRouting(f); const work = await f.create();
  const main = f.sessions.get('main')!; let notify: AgentMessageOptions['onAcceptance'];
  main.sendMessage = (async (text: string, options?: AgentMessageOptions) => {
    main.messages.push({ text, options }); notify = options?.onAcceptance;
    if (outcome === 'unknown') throw new Error('Native acknowledgement lost');
  }) as typeof main.sendMessage;
  const receipt = await f.call(work, 'send_main_message', { operationId: 'old-invocation', purpose: 'consultation', text: 'Assess once' });
  await f.coordinator.tick();
  expect(notify).toBeTypeOf('function');
  await f.restart(); const before = await f.coordinator.get(work.id);
  notify!({ disposition: 'started' }); await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).outbox!.find(item => item.id === receipt.id)).toMatchObject({ status: outcome === 'unknown' ? 'unknown' : 'accepted', resolvedTarget: route.origin });
  expect((await f.coordinator.get(work.id)).revision).toBe(before.revision);
  expect(f.coordinator.hasUnsettledRecipient(route.origin)).toBe(true); expect(main.messages).toHaveLength(1);
}, 10000);

it('settles a quiet review once without rewriting unchanged visible work, but surfaces changed phase', async () => {
  const f = await fixture(); const work = await f.create(); await f.acknowledge(work);
  f.advance(2000); await f.coordinator.tick();
  let current = await f.coordinator.get(work.id);
  const reviewId = f.coordinator.store.get(work.id).reviewIntentId!;
  const assessment = { revision: current.revision, reviewId, notify: false, phase: current.phase, waiting: current.waiting, summary: 'A paraphrase', nextAction: 'Another paraphrase' };
  await f.call(work, 'update_work', assessment);
  expect((await f.coordinator.get(work.id)).summary).toBe(current.summary);
  expect(f.coordinator.store.get(work.id).backgroundReviews?.at(-1)?.result?.notify).toBe(false);
  await expect(f.call(work, 'update_work', { ...assessment, revision: (await f.coordinator.get(work.id)).revision })).rejects.toThrow(/no longer awaiting/);
  f.sessions.get(work.tpmNativeSessionId!)!.setStatus('idle'); f.advance(2000); await f.coordinator.tick();
  current = await f.coordinator.get(work.id);
  await f.call(work, 'update_work', { ...assessment, revision: current.revision, reviewId: f.coordinator.store.get(work.id).reviewIntentId!, waiting: 'user' });
  expect(f.coordinator.store.get(work.id).backgroundReviews?.at(-1)?.result?.notify).toBe(true);
});

it('preserves legacy automatic work and cancels only undispatched reviews when delegation stops', async () => {
  const f = await fixture(); const work = await f.create(); await f.acknowledge(work);
  await f.coordinator.store.update(work.id, undefined, record => {
    delete record.work.delegated;
    record.work.outbox!.push({ id: 'not-sent', target: 'tpm', purpose: 'review', text: 'automatic', status: 'prepared', createdAt: work.createdAt });
  });
  await f.restart();
  const current = await f.coordinator.get(work.id); expect(current.delegated).toBe(true);
  await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'stop', action: 'set_delegated', delegated: false }, 'owner');
  expect((await f.coordinator.get(work.id)).outbox?.find(intent => intent.id === 'not-sent')?.status).toBe('canceled');
  expect(f.sessions.get(work.tpmNativeSessionId!)!.cancel).not.toHaveBeenCalled();
});

it('releases a stopped review that ends without assessment without scheduling another one', async () => {
  const f = await fixture(); const work = await f.create(); await f.acknowledge(work);
  f.advance(2000); await f.coordinator.tick();
  let current = await f.coordinator.get(work.id);
  const reviewId = f.coordinator.store.get(work.id).reviewIntentId;
  await f.coordinator.action({ id: work.id, revision: current.revision, operationId: 'stop', action: 'set_delegated', delegated: false }, 'user');
  const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  tpm.setStatus('idle'); f.advance(60000); await f.coordinator.tick();
  expect(f.coordinator.store.get(work.id).reviewIntentId).toBeUndefined();
  expect(f.coordinator.store.get(work.id).backgroundReviews?.find(review => review.id === reviewId)?.failed).toBe(true);
  expect(tpm.messages).toHaveLength(2);
  expect(tpm.cancel).not.toHaveBeenCalled();
});

it.each([false, true])('keeps TPM prefix recipients and pauses the current native takeover (restart before takeover: %s)', async restartBeforeTakeover => {
  const f = await fixture(); const work = await f.create();
  const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
  let current = work.tpmNativeSessionId!, frozen = false;
  f.access.controllerId = 'controller';
  f.access.sessionRouting = {
    resolve: anchor => ({ anchor, target: ref(anchor.nativeSessionId === work.tpmNativeSessionId ? current : anchor.nativeSessionId), operationIds: [] }),
    assertCurrent: (anchor, actual) => { if (f.access.sessionRouting!.resolve(anchor).target.nativeSessionId !== actual.nativeSessionId || frozen) throw new Error('Recipient not current or released'); },
  };
  const old = (await f.coordinator.extensions('codex', work.tpmNativeSessionId!))!.tools!.find(tool => tool.name === 'read_work')!;
  const candidate = (await f.coordinator.extensions('codex', work.tpmNativeSessionId!, () => 'B'))!.tools!.find(tool => tool.name === 'read_work')!;
  await expect(candidate.execute({})).rejects.toThrow(/current|released/);
  await f.acknowledge(work); f.sessions.set('B', new SessionManager('B'));
  current = 'B'; frozen = true;
  await expect(f.coordinator.extensions('codex', work.tpmNativeSessionId!)).resolves.toBeUndefined();
  await expect(old.execute({})).rejects.toThrow(/current|released/);
  await expect(candidate.execute({})).rejects.toThrow(/current|released/);
  expect((await f.coordinator.get(work.id)).tpmNativeSessionId).toBe('B');
  frozen = false;
  expect(JSON.parse(await candidate.execute({}))).toMatchObject({ id: work.id, tpmNativeSessionId: 'B' });
  const projected = { ...work, tpmNativeSessionId: 'B' };
  const document = await f.call(projected, 'write_work_document', { revision: (await f.coordinator.get(work.id)).revision, document: work.document, acceptance: work.acceptance });
  expect(document.tpmNativeSessionId).toBe('B');
  expect((await f.call(projected, 'schedule_check', { seconds: 30, reason: 'Check later' })).tpmNativeSessionId).toBe('B');
  await f.coordinator.tick();
  expect(f.sessions.get(work.tpmNativeSessionId!)!.leases).toBe(0);
  expect(f.sessions.get('B')!.leases).toBe(1);
  expect(f.sessions.get('B')!.messages).toHaveLength(0);
  f.advance(3000); await f.coordinator.tick();
  await expect.poll(async () => (await f.coordinator.get(work.id)).outbox?.find(intent => intent.target === 'tpm' && intent.purpose === 'review')?.status).toBe('accepted');
  expect(f.sessions.get('B')!.messages).toHaveLength(1);
  expect(f.sessions.get(work.tpmNativeSessionId!)!.leases).toBe(0);
  expect(f.coordinator.store.get(work.id).work.tpmNativeSessionId).toBe(work.tpmNativeSessionId);
  expect((await f.coordinator.get(work.id)).outbox!.at(-1)).toMatchObject({ resolvedTarget: ref('B') });
  if (restartBeforeTakeover) await f.restart();
  expect((await f.coordinator.extensions('codex', 'B'))!.tools!.map(tool => tool.name)).toContain('update_work');
  expect(f.coordinator.store.get(work.id).work.todo).toEqual(work.todo);
  expect(f.sessions.get('B')!.messages).toHaveLength(1);
  await f.coordinator.tick();
  const receipts = structuredClone((await f.coordinator.get(work.id)).outbox!);
  expect(receipts[0]).toMatchObject({ resolvedTarget: ref(work.tpmNativeSessionId!) });
  expect(receipts.at(-1)).toMatchObject({ resolvedTarget: ref('B') });
  const main = f.sessions.get('main')!, successor = f.sessions.get('B')!;
  expect(main.leases).toBe(1); expect(successor.leases).toBe(1);
  await f.coordinator.handoff('codex', 'B');
  expect(await f.coordinator.get(work.id)).toMatchObject({ paused: true, tpmNativeSessionId: 'B', mainNativeSessionId: 'main' });
  expect(f.coordinator.store.get(work.id).work.tpmNativeSessionId).toBe(work.tpmNativeSessionId);
  expect(main.leases).toBe(0); expect(successor.leases).toBe(0);
  expect(main.listeners.size).toBe(0); expect(successor.listeners.size).toBe(0);
  for (const operationId of ['available-slot-one', 'available-slot-two']) {
    const other = await f.create(operationId);
    expect(f.sessions.get(other.tpmNativeSessionId!)!.messages).toHaveLength(1);
  }
  for (const other of f.coordinator.store.all().filter(record => record.work.id !== work.id)) {
    await f.coordinator.action({ id: other.work.id, revision: other.work.revision, operationId: 'pause-other-' + other.work.id, action: 'pause' }, 'owner');
  }
  successor.setStatus('idle');
  f.advance(60_000); await f.coordinator.tick();
  await f.restart(); await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).paused).toBe(true);
  expect(successor.messages).toHaveLength(1);
  expect(main.leases).toBe(0); expect(successor.leases).toBe(0);
  expect((await f.coordinator.get(work.id)).outbox).toEqual(receipts);
  const paused = await f.coordinator.get(work.id);
  await f.coordinator.action({ id: work.id, revision: paused.revision, operationId: 'resume-successor', action: 'resume' }, 'owner');
  await expect.poll(async () => { await f.coordinator.tick(); return successor.messages.length; }).toBe(2);
  expect((await f.coordinator.get(work.id)).outbox!.slice(0, receipts.length)).toEqual(receipts);
  await f.coordinator.handoff('codex', work.tpmNativeSessionId!);
  expect((await f.coordinator.get(work.id)).paused).toBe(false);
  expect(main.leases).toBe(1); expect(successor.leases).toBe(1);
}, 10000);

it('leaves a TPM intent prepared when execution admission fails before dispatch', async () => {
  const f = await fixture(); const work = await f.create();
  f.access.execute = async () => { throw new AgentOperationRejectedError('reserved', 'Recipient reserved'); };
  const intent = await f.call(work, 'send_main_message', { operationId: 'frozen-before-claim', purpose: 'consultation', text: 'Wait for release' });
  await f.coordinator.tick();
  expect((await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)).toMatchObject({ status: 'prepared' });
  expect((await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!.resolvedTarget).toBeUndefined();
  expect(f.sessions.get('main')!.messages).toEqual([]);
});


it('native send visibility can precede durable TPM settlement and cannot authorize a stale work revision', async () => {
  const f = await fixture(); const work = await f.create();
  let release!: () => void; const waiting = new Promise<void>(done => { release = done; });
  const execute = f.access.execute;
  f.access.execute = async (agent, operation, dispatch) => {
    const result = await execute(agent, operation, dispatch);
    if (agent.agentId === 'main') await waiting;
    return result;
  };
  try {
    const intent = await f.call(work, 'send_main_message', { operationId: 'settlement-window', purpose: 'consultation', text: 'One input' });
    await waitMessages(f.sessions.get('main')!, 1);
    const visible = await f.coordinator.get(work.id);
    expect(visible.outbox!.find(item => item.id === intent.id)!.status).toBe('dispatching');
    release();
    await expect.poll(async () => (await f.coordinator.get(work.id)).outbox!.find(item => item.id === intent.id)!.status).toBe('accepted');
    await expect(f.coordinator.action({ id: work.id, revision: visible.revision, operationId: 'stale-pause', action: 'pause' }, 'owner')).rejects.toThrow('TPM work changed');
    const settled = await f.coordinator.get(work.id);
    expect(settled.revision).toBeGreaterThan(visible.revision);
    expect((await f.coordinator.action({ id: work.id, revision: settled.revision, operationId: 'fresh-pause', action: 'pause' }, 'owner')).paused).toBe(true);
  } finally { release(); }
});


it.each(['unknown', 'queued', 'void'] as const)('retains the own TPM recipient across restart after %s delivery', async outcome => {
  const f = await fixture(); const work = await f.create(); await f.acknowledge(work);
  const anchor = work.tpmNativeSessionId!, ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
  let current = anchor;
  f.access.sessionRouting = {
    resolve: source => ({ anchor: source, target: ref(source.nativeSessionId === anchor ? current : source.nativeSessionId), operationIds: [] }),
    assertCurrent: (source, actual) => { if (f.access.sessionRouting!.resolve(source).target.nativeSessionId !== actual.nativeSessionId) throw new Error('Retired recipient'); },
  };
  const native = f.sessions.get(anchor)!;
  native.sendMessage = (async (text: string, options?: AgentMessageOptions) => {
    native.messages.push({ text, options });
    if (outcome === 'unknown') throw new Error('Receipt lost');
    return outcome === 'queued' ? { disposition: 'queued' } : undefined;
  }) as typeof native.sendMessage;
  f.advance(3000); await f.coordinator.tick();
  const intent = f.coordinator.store.get(work.id).work.outbox!.at(-1)!;
  expect(intent).toMatchObject({ target: 'tpm', status: outcome === 'unknown' ? 'unknown' : 'accepted', resolvedTarget: ref(anchor) });
  expect(f.coordinator.hasUnsettledRecipient(ref(anchor))).toBe(true);
  current = 'B'; f.sessions.set('B', new SessionManager('B')); await f.restart(); await f.coordinator.tick();
  expect(f.coordinator.store.get(work.id).work.outbox!.find(item => item.id === intent.id)).toEqual(intent);
  expect(f.coordinator.hasUnsettledRecipient(ref(anchor))).toBe(true); expect(f.coordinator.hasUnsettledRecipient(ref('B'))).toBe(false);
  expect(native.messages).toHaveLength(2); expect(f.sessions.get('B')!.messages).toEqual([]);
  if (outcome === 'unknown') {
    await f.coordinator.close();
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = join(f.directory, `${work.id}.json`), saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.work.outbox.find((item: { id: string }) => item.id === intent.id).resolvedTarget;
    await writeFile(path, JSON.stringify(saved)); await f.restart(); await f.coordinator.tick();
    expect(f.coordinator.hasUnsettledRecipient(ref(anchor))).toBe(true); expect(f.coordinator.hasUnsettledRecipient(ref('B'))).toBe(true);
    expect(f.coordinator.hasUnsettledRecipient(ref('unrelated'))).toBe(false);
    expect(f.coordinator.store.get(work.id).work.outbox!.find(item => item.id === intent.id)!.resolvedTarget).toBeUndefined();
    expect(f.sessions.get('B')!.messages).toEqual([]);
  }
});
