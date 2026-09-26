import { AgentOperationRejectedError, prepareAgentOperation, validateSessionSetting } from './index.js';
import { describe, expect, it } from 'vitest';

import {
  type AgentCapabilities,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentSession,
  type AgentTimelineItem,
  type ProviderStreamItem,
} from './index.js';

describe('provider contract', () => {
  it('uses string bodies for message and reasoning timeline items', () => {
    const items: AgentTimelineItem[] = [
      { type: 'user_message', text: 'Inspect the workspace.' },
      { type: 'assistant_message', text: 'Done.' },
      { type: 'reasoning', text: 'I should read the relevant files.' },
    ];

    expect(items.map((item) => 'text' in item ? item.text : undefined)).toEqual([
      'Inspect the workspace.', 'Done.', 'I should read the relevant files.',
    ]);
  });

  it('keeps question, plan approval, and tool approval requests closed and distinct', () => {
    const requests: AgentInteractionRequest[] = [
      {
        kind: 'question',
        requestId: 'request-question',
        questions: [{
          questionId: 'release-channel',
          header: 'Release channel',
          prompt: 'Which channel should receive the build?',
          description: 'Select every acceptable destination.',
          required: true,
          selection: 'multiple',
          options: [
            { value: 'beta', label: 'Beta', description: 'Internal testers' },
            { value: 'stable', label: 'Stable', description: 'All users' },
          ],
          allowCustomText: true,
          allowDismiss: false,
        }],
      },
      {
        kind: 'plan_approval',
        requestId: 'request-plan',
        plan: '## Plan\n\nShip the verified build.',
        allowedActions: ['approve', 'approve_and_resume', 'reject'],
      },
      {
        kind: 'tool_approval',
        requestId: 'request-tool',
        toolCallId: 'tool-7',
        toolName: 'shell',
        summary: 'Run the release command.',
        detail: { type: 'shell', command: 'pnpm release', cwd: '/workspace' },
        allowedDecisions: ['allow', 'deny'],
        allowScopes: ['once', 'session'],
      },
    ];
    const responses: AgentInteractionResponse[] = [
      { kind: 'question', answers: [{ questionId: 'release-channel', selectedValues: ['beta'], customText: 'canary' }] },
      { kind: 'plan_approval', action: 'approve_and_resume' },
      { kind: 'tool_approval', decision: 'allow', scope: 'once' },
    ];

    expect(requests.map((request) => request.kind)).toEqual(['question', 'plan_approval', 'tool_approval']);
    expect(responses.map((response) => response.kind)).toEqual(['question', 'plan_approval', 'tool_approval']);
  });

  it('exposes explicit capabilities and text controls on a provider session', async () => {
    const calls: unknown[] = [];
    const capabilities: AgentCapabilities = {
      history: true,
      sendMessage: true,
      steer: true,
      cancel: true,
      readResource: false,
      interactions: { question: true, planApproval: true, toolApproval: true },
    };
    const session: Pick<AgentSession, 'capabilities' | 'sendMessage' | 'respondToInteraction' | 'steer' | 'cancel'> = {
      capabilities,
      async sendMessage(text) { calls.push(['message', text]); },
      async respondToInteraction(requestId, response) { calls.push(['interaction', requestId, response]); },
      async steer(text) { calls.push(['steer', text]); },
      async cancel() { calls.push(['cancel']); },
    };

    await session.sendMessage('Continue with the checks.');
    await session.respondToInteraction('request-plan', { kind: 'plan_approval', action: 'approve' });
    await session.steer?.('Use the updated target.');
    await session.cancel?.();

    expect(calls).toEqual([
      ['message', 'Continue with the checks.'],
      ['interaction', 'request-plan', { kind: 'plan_approval', action: 'approve' }],
      ['steer', 'Use the updated target.'],
      ['cancel'],
    ]);
  });

  it('allows history observations followed by exactly one boundary and live observations', () => {
    const stream: ProviderStreamItem[] = [
      {
        type: 'observation', sourceKey: 'native-history-1', occurredAt: 1_725_000_000_000, delivery: 'history',
        event: { type: 'timeline', provider: 'codex', item: { type: 'assistant_message', text: 'Earlier output.' } },
      },
      { type: 'history_boundary' },
      {
        type: 'observation', sourceKey: 'native-live-2', occurredAt: 1_725_000_000_001, delivery: 'live',
        event: { type: 'turn_started', provider: 'codex', turnId: 'turn-2' },
      },
    ];

    expect(stream.filter((item) => item.type === 'history_boundary')).toHaveLength(1);
    expect(stream.map((item) => item.type)).toEqual(['observation', 'history_boundary', 'observation']);
  });
});


it('classifies only explicit side-effect-free preparation as definitely rejected', async () => {
  expect(await prepareAgentOperation(() => 'ready')).toBe('ready');
  await expect(prepareAgentOperation(() => { throw new Error('Image unavailable'); })).rejects.toMatchObject({name: 'AgentOperationRejectedError', code: 'operation_preparation_failed'});
  const rejection = new AgentOperationRejectedError('busy', 'Busy');
  await expect(prepareAgentOperation(async () => { throw rejection; })).rejects.toBe(rejection);
  expect(() => validateSessionSetting([], 'missing', 'value')).toThrow(AgentOperationRejectedError);
});
