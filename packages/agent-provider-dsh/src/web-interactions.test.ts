import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import ApprovalService from '@deepseek-ai/dsh-user-approval';

import { createDshWebInteractionAdapter } from './web-interactions.js';

type QuestionRequest = {
  agent: TestAgent;
  signal?: AbortSignal;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    intent?: { kind: 'plan-review'; approve: string };
  }>;
};

type ApprovalRequest = {
  agent: TestAgent;
  signal?: AbortSignal;
  toolName: string;
  callId?: string;
  reason?: string;
};

type TestAgent = { id: string; session: { id: string; snapshotEvents(): never[] } };

type QuestionAnswer = { answers: Array<{ id: string; selected: string[]; custom?: string }> };
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

type QuestionListener = (request: QuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>;
type ApprovalListener = (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>;

class InteractionContext {
  readonly agent: TestAgent = { id: 'agent-1', session: { id: 'session-1', snapshotEvents: () => [] } };
  readonly child: TestAgent = { id: 'agent-2', session: { id: 'session-2', snapshotEvents: () => [] } };
  readonly webQuestionSignals: AbortSignal[] = [];
  readonly webApprovalSignals: AbortSignal[] = [];
  private readonly questionListeners: QuestionListener[] = [];
  private readonly approvalListeners: ApprovalListener[] = [];
  private questionAnswer = Promise.withResolvers<QuestionAnswer>();
  private approvalAnswer = Promise.withResolvers<ApprovalOutcome>();

  readonly agents = {
    get: (id: string) => [this.agent, this.child].find((agent) => agent.id === id),
    roots: () => [this.agent],
  };

  readonly userQuestions = {
    ask: (request: QuestionRequest): Promise<QuestionAnswer> => this.askQuestion(request),
  };

  readonly approval = {
    request: (request: ApprovalRequest): Promise<ApprovalOutcome> => this.askApproval(request),
  };

  get(name: string): unknown {
    if (name === 'agents') return this.agents;
    if (name === 'userQuestions') return this.userQuestions;
    if (name === 'approval') return this.approval;
    return undefined;
  }

  on(name: string, listener: QuestionListener | ApprovalListener, prepend = false): () => void {
    if (name === 'user-questions/request') {
      const listeners = this.questionListeners;
      if (prepend) listeners.unshift(listener as QuestionListener);
      else listeners.push(listener as QuestionListener);
      return () => { const index = listeners.indexOf(listener as QuestionListener); if (index >= 0) listeners.splice(index, 1); };
    }
    if (name === 'approval/request') {
      const listeners = this.approvalListeners;
      if (prepend) listeners.unshift(listener as ApprovalListener);
      else listeners.push(listener as ApprovalListener);
      return () => { const index = listeners.indexOf(listener as ApprovalListener); if (index >= 0) listeners.splice(index, 1); };
    }
    throw new Error(`Unexpected interaction event: ${name}`);
  }

  answerWebQuestion(answer: QuestionAnswer): void { this.questionAnswer.resolve(answer); }
  answerWebApproval(answer: ApprovalOutcome): void { this.approvalAnswer.resolve(answer); }

  private askQuestion(request: QuestionRequest): Promise<QuestionAnswer> {
    const next = (): Promise<QuestionAnswer> => {
      if (request.signal) this.webQuestionSignals.push(request.signal);
      return waitForAbort(request.signal, this.questionAnswer.promise);
    };
    return runWaterfall(this.questionListeners, request, next);
  }

  private askApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const next = (): Promise<ApprovalOutcome> => {
      if (request.signal) this.webApprovalSignals.push(request.signal);
      return waitForAbort(request.signal, this.approvalAnswer.promise);
    };
    return runWaterfall(this.approvalListeners, request, next);
  }
}

function runWaterfall<T, R>(listeners: Array<(request: T, next: () => Promise<R>) => Promise<R>>, request: T, final: () => Promise<R>): Promise<R> {
  let index = 0;
  const next = (): Promise<R> => listeners[index++]?.(request, next) ?? final();
  return next();
}

function waitForAbort<T>(signal: AbortSignal | undefined, answer: Promise<T>): Promise<T> {
  if (!signal) return answer;
  return Promise.race([answer, new Promise<T>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  })]);
}

async function drain(): Promise<void> { for (let index = 0; index < 16; index += 1) await Promise.resolve(); }

function nativeApprovalAgent(): { agent: Agent & TestAgent; audit: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [{ type: 'turn/start', data: { turn: 1 } }];
  const audit: Array<{ type: string; data: Record<string, unknown> }> = [];
  const agent = {
    id: 'native-agent',
    session: {
      id: 'native-session',
      get seq() { return events.length; },
      eventAt: (sequence: number) => events[sequence],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data };
        events.push(event);
        audit.push(event);
        return event;
      },
      snapshotEvents: () => events,
    },
  } as unknown as Agent & TestAgent;
  return { agent, audit };
}

async function nativeApprovalAdapter() {
  const { agent, audit } = nativeApprovalAgent();
  const context = new Context();
  await context.plugin(ApprovalService);
  const get = context.get.bind(context);
  Object.defineProperty(context, 'get', {
    configurable: true,
    value: (name: string) => name === 'agents'
      ? { get: (id: string) => id === agent.id ? agent : undefined, roots: () => [agent] }
      : get(name),
  });
  return { context, agent, audit, adapter: createDshWebInteractionAdapter(context) };
}

function requestId(adapter: ReturnType<typeof createDshWebInteractionAdapter>, sessionId = 'session-1'): string {
  const event = adapter.events(sessionId).find(({ kind }) => kind === 'interaction_requested');
  return (event?.payload as { request: { requestId: string } }).request.requestId;
}

function resolutions(adapter: ReturnType<typeof createDshWebInteractionAdapter>, sessionId = 'session-1') {
  return adapter.events(sessionId).filter(({ kind }) => kind === 'interaction_resolved').map(({ payload }) => payload);
}

const questionResponse = {
  kind: 'question' as const,
  answers: [{ questionId: 'destination', selectedValues: ['Home'], customText: 'after lunch' }],
};

describe('DSH Web interaction adapter', () => {
  it('journals a root Agent question before any remote session attaches', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    expect(adapter.events('session-1')).toMatchObject([{
      kind: 'interaction_requested',
      payload: { request: { kind: 'question', questions: [{ questionId: 'destination', options: [{ value: 'Home' }] }] } },
    }]);
    expect(adapter.hasPending('session-1')).toBe(true);

    context.answerWebQuestion({ answers: [{ id: 'destination', selected: ['Home'] }] });
    await expect(asking).resolves.toEqual({ answers: [{ id: 'destination', selected: ['Home'] }] });
    expect(resolutions(adapter)).toEqual([{
      requestId: requestId(adapter),
      response: { kind: 'question', answers: [{ questionId: 'destination', selectedValues: ['Home'] }] },
    }]);
    await adapter.dispose();
  });

  it('returns a Borgee question answer and aborts the losing Web presentation', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    expect(await adapter.respond('session-1', requestId(adapter), questionResponse)).toBe(true);
    await expect(asking).resolves.toEqual({ answers: [{ id: 'destination', selected: [], custom: 'Selected option: Home\nAdditional response: after lunch' }] });
    expect(context.webQuestionSignals).toHaveLength(1);
    expect(context.webQuestionSignals[0]?.aborted).toBe(true);
    expect(resolutions(adapter)).toEqual([{ requestId: requestId(adapter), response: questionResponse }]);
    await adapter.dispose();
  });

  it('keeps an accepted Web answer when the remote response arrives too late', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    context.answerWebQuestion({ answers: [{ id: 'destination', selected: ['Home'], custom: 'Web wins' }] });
    await expect(asking).resolves.toEqual({ answers: [{ id: 'destination', selected: ['Home'], custom: 'Web wins' }] });
    expect(await adapter.respond('session-1', requestId(adapter), questionResponse)).toBe(false);
    expect(resolutions(adapter)).toEqual([{
      requestId: requestId(adapter),
      response: { kind: 'question', answers: [{ questionId: 'destination', selectedValues: ['Home'], customText: 'Web wins' }] },
    }]);
    await adapter.dispose();
  });

  it('retains a pending root approval through a remote transport replacement', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.approval.request({ agent: context.agent, toolName: 'bash', callId: 'call-1', reason: 'Write a file' });
    await drain();
    const originalRequest = requestId(adapter);
    const observed: unknown[] = [];
    const unsubscribe = adapter.subscribe('session-1', (record) => observed.push(record));

    expect(await adapter.respond('session-1', originalRequest, { kind: 'tool_approval', decision: 'allow', scope: 'once' })).toBe(true);
    await expect(asking).resolves.toBe('allowed-once');
    expect(observed).toEqual([{ recordId: expect.any(String), kind: 'interaction_resolved', occurredAt: expect.any(Number), payload: {
      requestId: originalRequest, response: { kind: 'tool_approval', decision: 'allow', scope: 'once' },
    } }]);
    unsubscribe();
    await adapter.dispose();
  });

  it.each([
    { decision: 'allow' as const, outcome: 'allowed-once' },
    { decision: 'deny' as const, outcome: 'rejected' },
  ])('keeps a real native approval open for a Borgee $decision response when no Web answerer exists', async ({ decision, outcome }) => {
    const { context, agent, audit, adapter } = await nativeApprovalAdapter();
    const requesting = context.approval.request({ agent, toolName: 'bash', callId: 'native-call' });
    await drain();
    const id = requestId(adapter, 'native-session');

    expect(adapter.hasPending('native-session')).toBe(true);
    expect(await adapter.respond('native-session', id, { kind: 'tool_approval', decision, ...(decision === 'allow' ? { scope: 'once' as const } : {}) })).toBe(true);
    await expect(requesting).resolves.toBe(outcome);
    expect(audit).toMatchObject([
      { type: 'approval/asked', data: { toolName: 'bash', callId: 'native-call' } },
      { type: 'approval/decided', data: { outcome } },
    ]);
    await adapter.dispose();
    await context.fiber.dispose();
  });

  it('keeps the real native approval cancellation owned by its caller', async () => {
    const { context, agent, audit, adapter } = await nativeApprovalAdapter();
    const caller = new AbortController();
    const requesting = context.approval.request({ agent, toolName: 'bash', signal: caller.signal });
    await drain();

    expect(adapter.hasPending('native-session')).toBe(true);
    caller.abort(new Error('caller cancelled approval'));
    await expect(requesting).resolves.toBe('cancelled');
    expect(audit.at(-1)).toMatchObject({ type: 'approval/decided', data: { outcome: 'cancelled' } });
    await adapter.dispose();
    await context.fiber.dispose();
  });

  it('does not journal an interaction for an Agent that is not a live root', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.child,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    expect(adapter.events('session-2')).toEqual([]);
    context.answerWebQuestion({ answers: [{ id: 'destination', selected: ['Home'] }] });
    await expect(asking).resolves.toEqual({ answers: [{ id: 'destination', selected: ['Home'] }] });
    await adapter.dispose();
  });
});

describe('DSH Web interaction adapter plan review', () => {
  it('maps a Web approval through the native approve option rather than plan text', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{
        id: 'review', question: 'Proceed?', detail: 'Build the house',
        options: [{ label: 'Proceed' }, { label: 'Revise' }], intent: { kind: 'plan-review', approve: 'Proceed' },
      }],
    });
    await drain();

    context.answerWebQuestion({ answers: [{ id: 'review', selected: ['Proceed'] }] });
    await expect(asking).resolves.toEqual({ answers: [{ id: 'review', selected: ['Proceed'] }] });
    expect(resolutions(adapter)).toEqual([{
      requestId: requestId(adapter), response: { kind: 'plan_approval', action: 'approve_and_resume' },
    }]);
    await adapter.dispose();
  });
});

describe('DSH Web interaction adapter availability', () => {
  it('precedes an existing unavailable Web answerer and keeps the root request available to Borgee', async () => {
    const context = new InteractionContext();
    let webWasConsulted = false;
    context.on('user-questions/request', async () => {
      webWasConsulted = true;
      throw Object.assign(new Error('no connected Web answerer'), { code: 'NO_PROVIDER' });
    });
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    expect(webWasConsulted).toBe(true);
    expect(adapter.hasPending('session-1')).toBe(true);
    expect(await adapter.respond('session-1', requestId(adapter), questionResponse)).toBe(true);
    await expect(asking).resolves.toEqual({ answers: [{ id: 'destination', selected: [], custom: 'Selected option: Home\nAdditional response: after lunch' }] });
    await adapter.dispose();
  });

  it('rejects a pending local wait when the adapter is disposed', async () => {
    const context = new InteractionContext();
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    await adapter.dispose();
    await expect(asking).rejects.toThrow('adapter is disposed');
  });
});

describe('DSH Web interaction adapter turn ownership', () => {
  it('reads the current native turn from the rc1 Session snapshot', async () => {
    const context = new InteractionContext();
    context.agent.session.snapshotEvents = () => [{ type: 'turn/start', data: { turn: 8 } }] as never;
    const adapter = createDshWebInteractionAdapter(context as never);
    const asking = context.userQuestions.ask({
      agent: context.agent,
      questions: [{ id: 'destination', question: 'Where?', options: [{ label: 'Home' }] }],
    });
    await drain();

    expect(adapter.events('session-1')).toMatchObject([{ payload: { turnId: '8' } }]);
    expect(await adapter.respond('session-1', requestId(adapter), questionResponse)).toBe(true);
    await expect(asking).resolves.toBeDefined();
    await adapter.dispose();
  });
});
