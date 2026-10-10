import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
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
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.coordinator.close(); await rm(f.directory, { recursive: true, force: true }); } });
async function fixture(queueMessage = false) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-tpm-coordinator-'));
  const sessions = new Map<string, SessionManager>([['main', new SessionManager('main', queueMessage)]]);
  let now = 1_000_000; let available = true; let supported = ['codex']; let createFailure: Error | undefined;
  const creates: AgentSessionExtensions[] = [];
  const access: TpmSessionAccess = {
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
  const options = { stateDirectory: directory, now: () => now, tickMs: 1_000_000, heartbeatMs: 1000, waitingHeartbeatMs: 5000, minimumReviewMs: 30, coalesceMs: 5 };
  let coordinator = new TpmCoordinator(options, access); fixtures.push({ coordinator, directory }); await coordinator.ready;
  const input = { providerId: 'codex', mainNativeSessionId: 'main', title: 'Deliver isolated work', requirement: 'Agree on scope and deliver evidence.', operationId: 'create-one' };
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
}, 10000);

it('starts and retains background review leases without browser or Relay connections', async () => {
  const f = await fixture(); const work = await f.create(); const tpm = f.sessions.get(work.tpmNativeSessionId!)!;
  expect(tpm.messages[0]?.text).toContain(f.input.requirement);
  expect(f.sessions.get('main')!.leases).toBe(1); expect(tpm.leases).toBe(1);
  expect(f.sessions.get('main')!.listeners.size).toBe(1); expect(tpm.listeners.size).toBe(1);
  await f.acknowledge(work); f.advance(1000); await f.coordinator.tick(); await waitMessages(tpm, 2);
  expect(tpm.messages[1]?.text).toContain('Heartbeat check');
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
  if (queue) { await waitMessages(main, 1); expect(main.messages[0]?.options).toEqual({ delivery: 'next_turn' }); }
  else {
    await f.coordinator.tick(); await f.coordinator.store.flush(); expect(main.messages).toEqual([]);
    expect((await f.coordinator.get(work.id)).outbox?.find(value => value.id === intent.id)?.status).toBe('prepared');
    main.setStatus('idle'); await f.coordinator.tick(); await waitMessages(main, 1); expect(main.messages[0]?.options).toBeUndefined();
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
  expect(tpm.messages[1]?.text).toContain('bound main session changed');
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
  expect(tpm.messages[1]?.text).toContain('bound main session changed');
}, 10000);

it('limits automatic reviews to two and serves another work when a slot settles', async () => {
  const f = await fixture(); const one = await f.create('one'); const two = await f.create('two');
  const three = await f.coordinator.create({ ...f.input, operationId: 'three' }, 'browser-scope'); const third = f.sessions.get(three.tpmNativeSessionId!)!;
  await f.coordinator.tick(); await f.coordinator.store.flush();
  expect(f.sessions.get(one.tpmNativeSessionId!)!.messages).toHaveLength(1); expect(f.sessions.get(two.tpmNativeSessionId!)!.messages).toHaveLength(1);
  expect(third.messages).toEqual([]);
  await f.acknowledge(one); await expect.poll(async () => { await f.coordinator.tick(); return third.messages.length; }).toBe(1);
}, 10000);

it('pauses every affected work on native takeover and keeps bound session callbacks scoped', async () => {
  const f = await fixture(); const work = await f.create();
  await f.coordinator.handoff('codex', 'main'); const paused = await f.coordinator.get(work.id);
  expect(paused.paused).toBe(true); expect(paused.health).toContain('takeover'); expect(f.sessions.get('main')!.leases).toBe(0);
  await expect(f.call(work, 'send_main_message', { operationId: 'after-takeover', purpose: 'implementation', text: 'Continue' })).rejects.toThrow(/paused/);
  expect(await f.coordinator.extensions('codex', 'unrelated')).toBeUndefined();
  expect(await f.coordinator.extensions('copilot', work.tpmNativeSessionId!)).toBeUndefined();
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
it('archives only completed work, retaining the conversation and allowing restore or reopen', async () => {
  const f = await fixture(); const work = await f.create();
  await expect(f.coordinator.action({ id: work.id, revision: work.revision, operationId: 'early', action: 'archive' }, 'owner')).rejects.toThrow('Complete this work');
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
