import { runAgentProviderContractTests, validateAgentSessionCapabilities } from '@orchardworks/agent-provider-sdk/testing';
import { expect, it } from 'vitest';

import { createLiveDshProvider } from './live-provider.js';
import { createRecordedDshProvider } from './recorded-provider.js';
import { createCordisDshRuntime } from './runtime.js';
import type { DshTrace } from './trace/schema.js';

const trace: DshTrace = {
  header: {
    type: 'trace_header',
    format: 'borgee.dsh.trace.v1',
    sessionId: 'contract-session',
    nativeSessionHeader: {},
    runtimeInfo: { status: 'waiting', cwd: '/workspace', model: { id: 'deepseek-chat' } },
  },
  records: [{
    type: 'native_record',
    ordinal: 1,
    offset: 0,
    recordId: 'user-1',
    kind: 'session_event',
    payload: {
      type: 'user/message',
      data: { id: 'message-1', content: [{ type: 'text', text: 'Contract fixture' }] },
    },
  }],
};

runAgentProviderContractTests('recorded DSH Provider contract', async () => ({
  adapter: createRecordedDshProvider({ trace, mode: { kind: 'immediate' } }),
  createConfig: { sessionId: 'contract-session', cwd: '/workspace' },
  expected: { providerId: 'dsh-recorded', historyCount: 0, liveCount: 2 },
}));

class CordisContractContext {
  readonly externalQuestionProvider = { ask: async () => ({ answers: [] }) };
  questionDisposals = 0;
  approvalDisposals = 0;
  readonly sessions = { flush: async () => undefined };
  readonly agents = {
    create: async ({ sessionId }: { sessionId: string }) => this.handle(sessionId),
    resume: async ({ resumeSessionId }: { resumeSessionId: string }) => this.handle(resumeSessionId),
  };

  constructor(private readonly options: {
    questions?: 'available' | 'duplicate' | 'missing';
    approval?: boolean;
  } = {}) {}

  get(name: string): unknown {
    if (name === 'userQuestions') {
      if (this.options.questions === 'missing') return undefined;
      return {
        registerProvider: () => {
          if (this.options.questions === 'duplicate') {
            throw Object.assign(new Error('already owned'), { code: 'DUPLICATE_PROVIDER' });
          }
          return () => { this.questionDisposals += 1; };
        },
        ...(this.options.questions === 'duplicate' ? { provider: this.externalQuestionProvider } : {}),
      };
    }
    if (name === 'approval') return this.options.approval === false ? undefined : {};
    if (name === 'tools') {
      const tools = new Set(['ask_user_question', 'exit_plan_mode', 'bash']);
      return {
        get: (toolName: string) => tools.has(toolName) ? { name: toolName } : undefined,
        schemas: () => [...tools].map((toolName) => ({ name: toolName })),
      };
    }
    return undefined;
  }

  on(event: string): () => void {
    if (event === 'user-questions/request') return () => { this.questionDisposals += 1; };
    if (event !== 'approval/request') return () => undefined;
    return () => { this.approvalDisposals += 1; };
  }

  private handle(sessionId: string) {
    return {
      agent: {
        id: sessionId,
        status: 'idle',
        options: { model: 'deepseek-chat' },
        session: { id: sessionId, events: [], snapshotEvents() { return this.events; }, header: { cwd: '/workspace' } },
        followup: () => undefined,
        steer: () => undefined,
        cancel: () => undefined,
      },
      dispose: async () => undefined,
    };
  }
}

runAgentProviderContractTests('Cordis-backed DSH Provider contract', async () => {
  const context = new CordisContractContext();
  return {
    adapter: createLiveDshProvider({
      runtime: createCordisDshRuntime({ context: context as never }),
    }),
    createConfig: { sessionId: 'cordis-contract-session', cwd: '/workspace' },
    expected: { providerId: 'dsh', historyCount: 0, liveCount: 0 },
  };
});

it('keeps the Cordis-backed capability surface consistent with available waterfall services', async () => {
  const missing = new CordisContractContext({ questions: 'missing', approval: false });
  const missingProvider = createLiveDshProvider({
    runtime: createCordisDshRuntime({ context: missing as never }),
  });
  const missingSession = await missingProvider.createSession({ sessionId: 'cordis-missing-capability-session' });
  validateAgentSessionCapabilities(missingSession);
  expect(missingSession.capabilities.interactions).toEqual({
    question: false, planApproval: false, toolApproval: false,
  });
  await missingSession.dispose();
  await missingProvider.dispose();

  const duplicate = new CordisContractContext({ questions: 'duplicate', approval: false });
  const provider = createLiveDshProvider({
    runtime: createCordisDshRuntime({ context: duplicate as never }),
  });
  const session = await provider.createSession({ sessionId: 'cordis-capability-session' });

  validateAgentSessionCapabilities(session);
  expect(session.capabilities.interactions).toEqual({
    question: true, planApproval: true, toolApproval: false,
  });
  expect((duplicate.get('userQuestions') as { provider: unknown }).provider).toBe(duplicate.externalQuestionProvider);

  await session.dispose();
  await provider.dispose();
  expect(duplicate.questionDisposals).toBe(1);
  expect(duplicate.approvalDisposals).toBe(0);

  const owned = new CordisContractContext();
  const ownedProvider = createLiveDshProvider({
    runtime: createCordisDshRuntime({ context: owned as never }),
  });
  const ownedSession = await ownedProvider.createSession({ sessionId: 'cordis-owned-session' });
  validateAgentSessionCapabilities(ownedSession);
  expect(ownedSession.capabilities.interactions).toEqual({
    question: true, planApproval: true, toolApproval: true,
  });

  await ownedSession.dispose();
  await ownedProvider.dispose();
  expect(owned.questionDisposals).toBe(1);
  expect(owned.approvalDisposals).toBe(1);
});
