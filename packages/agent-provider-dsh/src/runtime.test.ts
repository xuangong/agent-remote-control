import type { AgentInteractionResponse } from '@borgee/agent-provider-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createCordisDshRuntime, installDshNativeInteractionBridge, type DshNativeObservation } from './index.js';
import { LiveDshSession } from './live-session.js';
import type { DshWebInteractionAdapter } from './web-interactions.js';

interface QuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind: 'plan-review'; approve: string };
}

interface FakeContextOptions {
  planning?: boolean;
  questions?: 'available' | 'duplicate' | 'missing';
  approval?: boolean;
  attachments?: boolean;
  tools?: readonly string[];
  questionDisposerError?: Error;
}

class FakeContext {
  readonly planningState: { active: boolean; pending?: boolean } = { active: false };
  readonly planMode = {
    get: () => ({ ...this.planningState }),
    set: (_agent: unknown, active: boolean) => { this.planningState.active = active; return 'committed'; },
  };
  readonly sessionListeners = new Set<(session: unknown, event: unknown) => void>();
  approvalHandler: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
  questionHandler: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
  questionDisposals = 0;
  approvalDisposals = 0;
  sessionEventDisposals = 0;
  handleDisposals = 0;
  readonly imageReads: unknown[] = [];
  readonly agent = {
    id: 'agent-1',
    status: 'idle',
    options: { model: 'deepseek-chat', provider: 'deepseek' },
    session: {
      id: 'session-1',
      events: [],
      snapshotEvents() { return this.events; },
      header: { cwd: '/workspace' },
    },
    followup: () => undefined,
    steer: () => undefined,
    cancel: () => undefined,
  };
  readonly agents = {
    create: async () => ({ agent: this.agent, dispose: async () => { this.handleDisposals += 1; } }),
    resume: async () => ({ agent: this.agent, dispose: async () => { this.handleDisposals += 1; } }),
  };
  readonly sessions = { flush: async () => undefined };

  readonly webQuestionSignals: AbortSignal[] = [];
  private readonly webQuestionAnswer = Promise.withResolvers<unknown>();
  readonly userQuestions = {
    ask: (request: unknown) => this.askQuestion(request, () => this.askWebQuestion(request)),
  };

  private askWebQuestion(request: unknown): Promise<unknown> {
    const signal = (request as { signal?: AbortSignal }).signal;
    if (signal) this.webQuestionSignals.push(signal);
    return this.webQuestionAnswer.promise;
  }

  answerWebQuestion(answer: unknown): void { this.webQuestionAnswer.resolve(answer); }

  constructor(private readonly options: FakeContextOptions = {}) {}

  get(name: string): unknown {
    if (name === 'planMode') return this.options.planning ? this.planMode : undefined;
    if (name === 'userQuestions') {
      if (this.options.questions === 'missing') return undefined;
      return this.userQuestions;
    }
    if (name === 'approval') return this.options.approval === false ? undefined : {};
    if (name === 'tools') {
      const tools = new Set(this.options.tools ?? ['ask_user_question', 'exit_plan_mode', 'bash']);
      return {
        get: (toolName: string) => tools.has(toolName) ? { name: toolName } : undefined,
        schemas: () => [...tools].map((toolName) => ({ name: toolName })),
      };
    }
    if (name === 'attachments') {
      if (this.options.attachments === false) return undefined;
      return {
        readImage: async (reference: unknown) => {
          this.imageReads.push(reference);
          return { ref: reference, data: Uint8Array.of(9, 8, 7) };
        },
      };
    }
    return undefined;
  }

  askQuestion(request: unknown, next: () => Promise<unknown> = async () => ({ answers: [] })): Promise<unknown> {
    return this.questionHandler ? this.questionHandler(request, next) : next();
  }

  askApproval(request: unknown, next: () => Promise<unknown> = async () => 'unavailable'): Promise<unknown> {
    return this.approvalHandler ? this.approvalHandler(request, next) : next();
  }

  on(event: string, listener: (...args: never[]) => unknown): () => void {
    if (event === 'session/event') {
      this.sessionListeners.add(listener as never);
      return () => {
        this.sessionEventDisposals += 1;
        this.sessionListeners.delete(listener as never);
      };
    }
    if (event === 'user-questions/request') {
      if (this.options.questions === 'missing') throw new Error('user questions are unavailable');
      this.questionHandler = listener as never;
      return () => {
        this.questionDisposals += 1;
        this.questionHandler = undefined;
        if (this.options.questionDisposerError) throw this.options.questionDisposerError;
      };
    }
    if (event === 'approval/request') {
      if (this.options.approval === false) throw new Error('approval is unavailable');
      this.approvalHandler = listener as never;
      return () => {
        this.approvalDisposals += 1;
        this.approvalHandler = undefined;
      };
    }
    throw new Error(`unexpected event ${event}`);
  }
}

function requested(records: readonly DshNativeObservation[]) {
  const record = records.find(({ kind }) => kind === 'interaction_requested');
  if (!record || typeof record.payload !== 'object' || record.payload === null) throw new Error('missing request');
  return (record.payload as { request: { requestId: string; kind: string } }).request;
}

function sharedInteractionHistory(records: readonly DshNativeObservation[]): DshWebInteractionAdapter {
  return {
    ready: async () => undefined,
    events: () => records,
    subscribe: () => () => undefined,
    hasPending: () => false,
    respond: async () => false,
    dispose: async () => undefined,
  };
}

function requestedKind(records: readonly DshNativeObservation[], kind: string) {
  const record = records.find((candidate) => {
    if (candidate.kind !== 'interaction_requested' || typeof candidate.payload !== 'object' || candidate.payload === null) return false;
    const request = (candidate.payload as { request?: { kind?: string } }).request;
    return request?.kind === kind;
  });
  if (!record || typeof record.payload !== 'object' || record.payload === null) throw new Error(`missing ${kind} request`);
  return (record.payload as { request: { requestId: string; kind: string } }).request;
}

function interactionRecord(
  records: readonly DshNativeObservation[],
  kind: 'interaction_requested' | 'interaction_resolved',
  requestId: string,
): DshNativeObservation {
  const record = records.find((candidate) => {
    if (candidate.kind !== kind || typeof candidate.payload !== 'object' || candidate.payload === null) return false;
    const payload = candidate.payload as { request?: { requestId?: string }; requestId?: string };
    return (kind === 'interaction_requested' ? payload.request?.requestId : payload.requestId) === requestId;
  });
  if (!record) throw new Error(`missing ${kind} ${requestId}`);
  return record;
}

function payloadOf(record: DshNativeObservation): Record<string, unknown> {
  if (typeof record.payload !== 'object' || record.payload === null) throw new Error('missing payload');
  return record.payload as Record<string, unknown>;
}

function beginTurn(context: FakeContext): void {
  context.agent.session.events.push({
    type: 'turn/start', seq: 0, time: 1_725_000_000_000, data: { turn: 'turn-1' },
  } as never);
}

function endTurn(context: FakeContext): void {
  context.agent.session.events.push({
    type: 'turn/end', seq: context.agent.session.events.length, time: 1_725_000_000_001, data: { turn: 'turn-1' },
  } as never);
}

function beginSecondTurn(context: FakeContext): void {
  context.agent.session.events.push({
    type: 'turn/start', seq: context.agent.session.events.length, time: 1_725_000_000_002, data: { turn: 'turn-2' },
  } as never);
}

async function openRuntime(context = new FakeContext()) {
  const runtime = createCordisDshRuntime({ context: context as never });
  const agent = await runtime.create({ sessionId: 'session-1' });
  const records: DshNativeObservation[] = [];
  agent.subscribe((record) => records.push(record));
  return { context, runtime, agent, records };
}

describe('Cordis DSH runtime interactions', () => {
  it('settles a native Web question when Borgee answers first and aborts the losing presentation', async () => {
    const context = new FakeContext();
    const restore = installDshNativeInteractionBridge(context as never);
    const { agent, records } = await openRuntime(context);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'language', question: 'Choose language', options: [{ label: 'English' }] }],
    });
    await Promise.resolve();
    const request = requested(records);
    expect(context.webQuestionSignals).toHaveLength(1);
    expect(agent.respondToInteraction(request.requestId, {
      kind: 'question', answers: [{ questionId: 'language', selectedValues: ['English'] }],
    })).toBe(true);
    await expect(asking).resolves.toEqual({ answers: [{ id: 'language', selected: ['English'] }] });
    expect(context.webQuestionSignals[0]?.aborted).toBe(true);
    await agent.dispose();
    restore();
  });

  it('releases a borrowed Agent adapter without disposing the native handle', async () => {
    const context = new FakeContext();
    const runtime = createCordisDshRuntime({ context: context as never });

    const borrowed = await runtime.borrow(context.agent as never);
    await borrowed.dispose();

    expect(context.handleDisposals).toBe(0);
    expect(context.sessionEventDisposals).toBe(1);
    await runtime.dispose();
  });

  it('observes shared Web interactions without acquiring native question or approval ownership', async () => {
    const context = new FakeContext({ planning: true });
    const record: DshNativeObservation = { kind: 'interaction_requested', recordId: 'web-question', occurredAt: 1,
      payload: { request: { kind: 'question', requestId: 'web-question', questions: [] } } };
    let listener: ((event: DshNativeObservation) => void) | undefined;
    const stop = vi.fn();
    const interactions: DshWebInteractionAdapter = {
      ready: async () => undefined,
      events: (sessionId) => { expect(sessionId).toBe('session-1'); return [record]; },
      subscribe: (sessionId, receive) => { expect(sessionId).toBe('session-1'); listener = receive; return stop; },
      hasPending: () => true,
      respond: vi.fn(async () => false),
      dispose: vi.fn(async () => undefined),
    };
    const runtime = createCordisDshRuntime({ context: context as never, interactions });
    const agent = await runtime.create({ sessionId: 'session-1' });
    expect(context.questionHandler).toBeUndefined();
    expect(context.approvalHandler).toBeUndefined();
    expect(agent.features.interactions).toEqual({ question: true, planApproval: true, toolApproval: true });
    expect(agent.events).toEqual([record]);
    const observed: DshNativeObservation[] = [];
    agent.subscribe((event) => observed.push(event));
    listener?.(record);
    expect(observed).toEqual([record]);
    const response = { kind: 'question' as const, answers: [] };
    expect(await agent.respondToInteraction('web-question', response)).toBe(false);
    expect(interactions.respond).toHaveBeenCalledWith('session-1', 'web-question', response);
    expect(() => agent.setPlanning?.(true)).toThrow('pending interactions');
    await agent.dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(interactions.dispose).not.toHaveBeenCalled();
  });

  it('interleaves completed Web questions before later native replies during hydration', async () => {
    const context = new FakeContext();
    context.agent.session.events.push(
      { type: 'turn/start', seq: 0, time: 500, data: { turn: 'turn-1' } } as never,
      { type: 'assistant/chunk', seq: 1, time: 3000, data: { turn: 'turn-1', step: 1, chunk: { type: 'text-delta', index: 0, text: 'I used your answer.' } } } as never,
    );
    const request = { kind: 'question', requestId: 'web-question', questions: [{
      questionId: 'choice', header: 'Choice', prompt: 'Choose?', required: true, selection: 'single',
      options: [{ value: 'yes', label: 'Yes' }], allowCustomText: false, allowDismiss: false,
    }] };
    const response = { kind: 'question', answers: [{ questionId: 'choice', selectedValues: ['yes'] }] };
    const interactions = sharedInteractionHistory([
      { kind: 'interaction_requested', recordId: 'question-requested', occurredAt: 1000, payload: { request, turnId: 'turn-1' } },
      { kind: 'interaction_resolved', recordId: 'question-resolved', occurredAt: 2000, payload: { requestId: request.requestId, response, turnId: 'turn-1' } },
    ]);
    const runtime = createCordisDshRuntime({ context: context as never, interactions });
    const owned = await runtime.create({ sessionId: 'session-1' });
    const session = new LiveDshSession(owned, { providerId: 'dsh', sessionId: 'session-1' }, { get: () => undefined });
    const history = [];
    for await (const record of session.observe()) {
      if (record.type === 'history_boundary') break;
      history.push(record);
    }
    expect(history.map(({ event }) => event.type)).toEqual(['turn_started', 'interaction_requested', 'interaction_resolved', 'timeline']);
    expect(history.map(({ occurredAt }) => occurredAt)).toEqual([500, 1000, 2000, 3000]);
    expect(history.at(-1)?.event).toMatchObject({ type: 'timeline', item: { type: 'assistant_message', text: 'I used your answer.' } });
  });

  it('preserves native sequence across tied, missing, and regressing timestamps when merging interaction history', async () => {
    const context = new FakeContext();
    const nativeTimes = [1000, undefined, 900, 3000];
    context.agent.session.events.push(...nativeTimes.map((time, seq) => ({ type: 'step/start', seq, time, data: { turn: 'turn-1' } })) as never[]);
    const interactions = sharedInteractionHistory([
      { kind: 'interaction_requested', recordId: 'requested', occurredAt: 1000, payload: {} },
      { kind: 'interaction_resolved', recordId: 'resolved', occurredAt: 3000, payload: {} },
    ]);
    const runtime = createCordisDshRuntime({ context: context as never, interactions });
    const owned = await runtime.create({ sessionId: 'session-1' });
    expect(owned.events.map(({ recordId }) => recordId)).toEqual([
      'dsh:session-1:event:0', 'dsh:session-1:event:1', 'dsh:session-1:event:2',
      'requested', 'dsh:session-1:event:3', 'resolved',
    ]);
    expect(owned.events.filter(({ kind }) => kind === 'session_event').map(({ occurredAt }) => occurredAt)).toEqual(nativeTimes);
    expect(interactions.events('session-1').map(({ recordId }) => recordId)).toEqual(['requested', 'resolved']);
    await owned.dispose();
  });

  it('uses services in the agent preset realm and the actual request model', async () => {
    const context = new FakeContext({ tools: [] });
    const rootGet = context.get.bind(context);
    context.get = (name) => name === 'agentPresets' ? { serviceFor: (_agent: unknown, service: string) => {
      if (service === 'planMode') return context.planMode;
      if (service === 'tools') return { get: () => ({}), schemas: () => [{}] };
      return undefined;
    } } : rootGet(name);
    Object.assign(context.agent.session, { requestHeader: () => ({ config: { model: 'request-selected-model' } }) });
    const runtime = createCordisDshRuntime({ context: context as never });
    const agent = await runtime.create({ sessionId: 'session-1', planning: true });
    expect(agent.features.planning).toBe(true);
    expect(agent.features.interactions).toEqual({ question: true, planApproval: true, toolApproval: true });
    expect(agent.runtimeInfo).toMatchObject({ model: 'request-selected-model', planning: { active: true } });
    await agent.dispose();
  });

  it('checks planning after setup and disposes a newly created owner if unsupported', async () => {
    const context = new FakeContext();
    const runtime = createCordisDshRuntime({ context: context as never });
    await expect(runtime.create({ sessionId: 'session-1', planning: true })).rejects.toThrow('unsupported');
    expect(context.handleDisposals).toBe(1);
    expect(context.sessionListeners.size).toBe(0);
  });
  it('applies session planning and preserves a pending request to leave planning', async () => {
    const context = new FakeContext({ planning: true });
    const runtime = createCordisDshRuntime({ context: context as never });
    const agent = await runtime.create({ sessionId: 'session-1', planning: true });
    expect(agent.features.planning).toBe(true);
    expect(agent.runtimeInfo.planning).toEqual({ active: true });
    context.planningState.pending = false;
    expect(agent.runtimeInfo.planning).toEqual({ active: true, requested: false });
    delete context.planningState.pending;
    agent.setPlanning?.(false);
    expect(agent.runtimeInfo.planning).toEqual({ active: false });
    await agent.dispose();
  });

  it('refuses unavailable planning and leaves a busy or waiting session unchanged', async () => {
    const unavailable = createCordisDshRuntime({ context: new FakeContext() as never });
    await expect(unavailable.create({ sessionId: 'session-1', planning: true })).rejects.toThrow('planning');
    const ordinary = await unavailable.create({ sessionId: 'session-1', planning: false });
    expect(ordinary.features.planning).toBe(false);
    expect(ordinary.runtimeInfo.planning).toBeUndefined();
    await ordinary.dispose();
    const { context, agent } = await openRuntime(new FakeContext({ planning: true }));
    beginTurn(context);
    expect(() => agent.setPlanning?.(true)).toThrow('idle');
    expect(agent.runtimeInfo.planning).toEqual({ active: false });
    endTurn(context);
    const reply = context.askQuestion({ agent: context.agent, questions: [{ id: 'q', question: 'Continue?' }] });
    expect(() => agent.setPlanning?.(true)).toThrow('pending');
    agent.respondToInteraction(requested(agent.events).requestId, { kind: 'question', answers: [{ questionId: 'q', selectedValues: [], customText: 'Continue' }] });
    await reply;
    await agent.dispose();
  });

  it('returns plan revision feedback to the native review without approving it', async () => {
    const { context, agent, records } = await openRuntime();
    const reply = context.askQuestion({ agent: context.agent, questions: [{
      id: 'review', question: 'Review?', detail: '# Plan',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }] });
    const requestId = requested(records).requestId;
    expect(() => agent.respondToInteraction(requestId, {
      kind: 'plan_approval', action: 'approve_and_resume', feedback: 'Change it',
    } as never)).toThrow('feedback');
    agent.respondToInteraction(requestId, { kind: 'plan_approval', action: 'reject', feedback: 'Read only the README.' });
    await expect(reply).resolves.toEqual({ answers: [{ id: 'review', selected: ['Keep planning'], custom: 'Read only the README.' }] });
    await agent.dispose();
  });

  it('registers a native user-questions waterfall listener without displacing another answerer', async () => {
    const context = new FakeContext({ questions: 'duplicate' });
    const runtime = createCordisDshRuntime({ context: context as never });
    const agent = await runtime.create({ sessionId: 'session-1' });

    expect(agent.features.interactions).toMatchObject({ question: true, planApproval: true });
    expect(context.questionHandler).toBeDefined();

    await agent.dispose();
    expect(context.questionDisposals).toBe(0);
    await runtime.dispose();
    expect(context.questionDisposals).toBe(1);
    expect(context.questionHandler).toBeUndefined();
  });

  it('advertises optional interaction capabilities only for owned bindings and releases their disposers', async () => {
    const missing = new FakeContext({ questions: 'missing', approval: false });
    const unavailable = await createCordisDshRuntime({ context: missing as never })
      .create({ sessionId: 'session-1' });

    expect(unavailable.features.interactions).toEqual({
      question: false, planApproval: false, toolApproval: false,
    });
    expect(missing.questionHandler).toBeUndefined();
    expect(missing.approvalHandler).toBeUndefined();
    await unavailable.dispose();

    const owned = new FakeContext();
    const runtime = createCordisDshRuntime({ context: owned as never });
    const available = await runtime.create({ sessionId: 'session-1' });
    expect(available.features.interactions).toEqual({
      question: true, planApproval: true, toolApproval: true,
    });
    expect(owned.questionHandler).toBeDefined();
    expect(owned.approvalHandler).toBeDefined();

    await available.dispose();
    expect(owned.questionDisposals).toBe(0);
    await runtime.dispose();
    expect(owned.questionDisposals).toBe(1);
    expect(owned.approvalDisposals).toBe(1);
    expect(owned.questionHandler).toBeUndefined();
    expect(owned.approvalHandler).toBeUndefined();
  });

  it('advertises only interactions that the owned Agent can actually trigger', async () => {
    const noTools = await createCordisDshRuntime({
      context: new FakeContext({ tools: [] }) as never,
    }).create({ sessionId: 'session-1' });
    expect(noTools.features.interactions).toEqual({
      question: false, planApproval: false, toolApproval: false,
    });
    await noTools.dispose();

    const approvalOnly = await createCordisDshRuntime({
      context: new FakeContext({ tools: ['bash'] }) as never,
    }).create({ sessionId: 'session-1' });
    expect(approvalOnly.features.interactions).toEqual({
      question: false, planApproval: false, toolApproval: true,
    });
    await approvalOnly.dispose();
  });

  it('delegates foreign-agent questions without creating a pending interaction', async () => {
    const { context, agent, records } = await openRuntime();

    await expect(context.askQuestion({
      agent: { ...context.agent, id: 'foreign-agent' },
      questions: [{ id: 'language', question: 'Choose language', options: [{ label: 'English' }] }],
    }, async () => ({ answers: [{ id: 'language', selected: ['English'] }] }))).resolves.toEqual({
      answers: [{ id: 'language', selected: ['English'] }],
    });

    expect(records).toEqual([]);
    await agent.dispose();
  });

  it('projects an owned native user-questions waterfall request and round-trips stable answers', async () => {
    const { context, agent, records } = await openRuntime();
    const items: QuestionItem[] = [{
      id: 'response-style', question: 'Choose a response style', header: 'Response style',
      options: [{ label: 'Concise' }, { label: 'Detailed', description: 'Include supporting detail' }],
      multiSelect: false,
    }];
    const answering = context.askQuestion({ questions: items, agent: context.agent });
    await Promise.resolve();
    const request = requested(records);

    expect(request).toMatchObject({
      kind: 'question',
      questions: [{
        questionId: 'response-style', header: 'Response style', prompt: 'Choose a response style', required: true,
        selection: 'single',
        options: [{ value: 'Concise', label: 'Concise' }, { value: 'Detailed', label: 'Detailed', description: 'Include supporting detail' }],
        allowCustomText: true, allowDismiss: false,
      }],
    });
    const response: AgentInteractionResponse = {
      kind: 'question', answers: [{ questionId: 'response-style', selectedValues: ['Detailed'], customText: 'Please be concise' }],
    };
    expect(agent.respondToInteraction(request.requestId, response)).toBe(true);
    await expect(answering).resolves.toEqual({
      answers: [{ id: 'response-style', selected: ['Detailed'], custom: 'Please be concise' }],
    });
    expect(agent.respondToInteraction(request.requestId, response)).toBe(false);
    await agent.dispose();
  });

  it('does not consume a native pending question when a required answer is empty', async () => {
    const { context, agent, records } = await openRuntime();
    const answering = context.askQuestion({
      agent: context.agent,
      questions: [{ id: 'language', question: 'Choose language', options: [{ label: 'English' }] }],
    });
    await Promise.resolve();
    const request = requested(records);

    expect(() => agent.respondToInteraction(request.requestId, {
      kind: 'question', answers: [],
    })).toThrow('requires an answer');
    expect(agent.respondToInteraction(request.requestId, {
      kind: 'question', answers: [{ questionId: 'language', selectedValues: ['English'] }],
    })).toBe(true);
    await expect(answering).resolves.toEqual({
      answers: [{ id: 'language', selected: ['English'] }],
    });
    await agent.dispose();
  });

  it('maps plan-review intent to plan approval without guessing from option order', async () => {
    const { context, agent, records } = await openRuntime();
    const items: QuestionItem[] = [{
      id: 'plan', question: 'Proceed?', detail: '## Plan\n\nShip it.',
      options: [{ label: 'Reject' }, { label: 'Proceed' }],
      intent: { kind: 'plan-review', approve: 'Proceed' },
    }];
    const answering = context.askQuestion({ questions: items, agent: context.agent });
    await Promise.resolve();
    const request = requested(records);

    expect(request).toMatchObject({
      kind: 'plan_approval', plan: '## Plan\n\nShip it.', allowedActions: ['approve_and_resume', 'reject'],
    });
    expect(agent.respondToInteraction(request.requestId, {
      kind: 'plan_approval', action: 'approve_and_resume',
    })).toBe(true);
    await expect(answering).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Proceed'] }] });
    await agent.dispose();
  });

  it('answers approval/request with one-shot allow or rejection and never advertises session scope', async () => {
    const { context, agent, records } = await openRuntime();
    if (!context.approvalHandler) throw new Error('approval handler was not registered');
    const deciding = context.askApproval({
      agent: context.agent, toolName: 'bash', callId: 'call-1', reason: 'Run build',
    }, async () => 'unavailable');
    await Promise.resolve();
    const request = requested(records);

    expect(request).toMatchObject({
      kind: 'tool_approval', toolCallId: 'call-1', toolName: 'bash', summary: 'Run build',
      detail: { type: 'other', description: 'Run build' },
      allowedDecisions: ['allow', 'deny'], allowScopes: ['once'],
    });
    expect(agent.respondToInteraction(request.requestId, {
      kind: 'tool_approval', decision: 'allow', scope: 'once',
    })).toBe(true);
    await expect(deciding).resolves.toBe('allowed-once');

    const rejecting = context.askApproval({
      agent: context.agent, toolName: 'write', callId: 'call-2', reason: 'Overwrite file',
    }, async () => 'unavailable');
    await Promise.resolve();
    const second = requested(records.filter((record) => record.recordId !== records[0]?.recordId));
    expect(agent.respondToInteraction(second.requestId, {
      kind: 'tool_approval', decision: 'deny', message: 'No',
    })).toBe(true);
    await expect(rejecting).resolves.toBe('rejected');
    await agent.dispose();
  });

  it('reuses each pending native request record and correlates question, plan, and tool resolution to the active turn', async () => {
    const context = new FakeContext();
    beginTurn(context);
    const { agent, records } = await openRuntime(context);

    const questionAnswering = context.askQuestion({
      agent: context.agent,
      questions: [{ id: 'language', question: 'Choose', options: [{ label: 'English' }] }],
    });
    await Promise.resolve();
    const question = requestedKind(records, 'question');
    const firstHistoryRecord = interactionRecord(agent.events, 'interaction_requested', question.requestId);
    const secondHistoryRecord = interactionRecord(agent.events, 'interaction_requested', question.requestId);
    expect(secondHistoryRecord).toBe(firstHistoryRecord);
    expect(payloadOf(firstHistoryRecord).turnId).toBe('turn-1');
    expect(agent.respondToInteraction(question.requestId, {
      kind: 'question', answers: [{ questionId: 'language', selectedValues: ['English'] }],
    })).toBe(true);
    expect(payloadOf(interactionRecord(records, 'interaction_resolved', question.requestId)).turnId).toBe('turn-1');
    await questionAnswering;

    const planAnswering = context.askQuestion({
      agent: context.agent,
      questions: [{
        id: 'plan', question: 'Proceed?', detail: 'Ship it.',
        options: [{ label: 'Reject' }, { label: 'Proceed' }],
        intent: { kind: 'plan-review', approve: 'Proceed' },
      }],
    });
    await Promise.resolve();
    const plan = requestedKind(records, 'plan_approval');
    expect(payloadOf(interactionRecord(agent.events, 'interaction_requested', plan.requestId)).turnId).toBe('turn-1');
    expect(agent.respondToInteraction(plan.requestId, {
      kind: 'plan_approval', action: 'approve_and_resume',
    })).toBe(true);
    expect(payloadOf(interactionRecord(records, 'interaction_resolved', plan.requestId)).turnId).toBe('turn-1');
    await planAnswering;

    if (!context.approvalHandler) throw new Error('approval handler was not registered');
    const toolAnswering = context.askApproval({
      agent: context.agent, toolName: 'bash', callId: 'call-1', reason: 'Run build',
    }, async () => 'unavailable');
    await Promise.resolve();
    const tool = requestedKind(records, 'tool_approval');
    expect(payloadOf(interactionRecord(agent.events, 'interaction_requested', tool.requestId)).turnId).toBe('turn-1');
    expect(agent.respondToInteraction(tool.requestId, {
      kind: 'tool_approval', decision: 'deny', message: 'No',
    })).toBe(true);
    expect(payloadOf(interactionRecord(records, 'interaction_resolved', tool.requestId)).turnId).toBe('turn-1');
    await toolAnswering;

    await agent.dispose();
  });

  it('retains the request turn when a question resolves after a later turn starts or is aborted', async () => {
    const context = new FakeContext();
    beginTurn(context);
    const { agent, records } = await openRuntime(context);
    const controller = new AbortController();
    const answering = context.askQuestion({
      agent: context.agent,
      questions: [{ id: 'normal', question: 'Choose', options: [{ label: 'English' }] }],
    });
    const cancelling = context.askQuestion({
      agent: context.agent,
      signal: controller.signal,
      questions: [{ id: 'cancel', question: 'Choose', options: [{ label: 'English' }] }],
    });
    await Promise.resolve();
    const [normal, cancelled] = records
      .filter((record) => record.kind === 'interaction_requested')
      .map((record) => (payloadOf(record).request as { requestId: string }));

    endTurn(context);
    beginSecondTurn(context);
    expect(agent.respondToInteraction(normal.requestId, {
      kind: 'question', answers: [{ questionId: 'normal', selectedValues: ['English'] }],
    })).toBe(true);
    const cancellation = expect(cancelling).rejects.toThrow('native question canceled');
    controller.abort(new Error('native question canceled'));

    expect(payloadOf(interactionRecord(records, 'interaction_resolved', normal.requestId)).turnId).toBe('turn-1');
    expect(payloadOf(interactionRecord(records, 'interaction_resolved', cancelled.requestId)).turnId).toBe('turn-1');
    await expect(answering).resolves.toEqual({ answers: [{ id: 'normal', selected: ['English'] }] });
    await cancellation;
    await agent.dispose();
  });

  it('finishes every owned-agent cleanup step after a question disposer fails and preserves that first failure', async () => {
    const questionDisposerError = new Error('question cleanup failed');
    const context = new FakeContext({ questionDisposerError });
    const { runtime, agent, records } = await openRuntime(context);
    const delivered: DshNativeObservation[] = [];
    agent.subscribe((record) => delivered.push(record));
    const answering = context.askQuestion({
      agent: context.agent,
      questions: [{ id: 'language', question: 'Choose language', options: [{ label: 'English' }] }],
    });
    await Promise.resolve();

    await agent.dispose();

    expect(context.questionDisposals).toBe(0);
    expect(context.approvalDisposals).toBe(0);
    await expect(runtime.dispose()).rejects.toBe(questionDisposerError);
    expect(context.questionDisposals).toBe(1);
    expect(context.approvalDisposals).toBe(1);
    expect(context.sessionEventDisposals).toBe(1);
    expect(context.sessionListeners.size).toBe(0);
    expect(context.handleDisposals).toBe(1);
    expect(records).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    await expect(answering).rejects.toThrow('DSH question was canceled');
  });

  it('reads attachment bytes through ctx.attachments.readImage', async () => {
    const { context, agent } = await openRuntime();
    const reference = {
      attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    };

    await expect(agent.readImage(reference)).resolves.toEqual({
      data: Uint8Array.of(9, 8, 7), mediaType: 'image/png',
    });
    expect(context.imageReads).toEqual([reference]);
    await agent.dispose();
  });
});
