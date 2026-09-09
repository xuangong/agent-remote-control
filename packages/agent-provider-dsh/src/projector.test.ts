import { describe, expect, it } from 'vitest';

import { DshGeneratedResourceReader } from './generated-resource.js';
import { DshProjector, type DshNativeObservation } from './projector.js';

function event(recordId: string, type: string, data: Record<string, unknown>, seq = 0): DshNativeObservation {
  return {
    recordId,
    occurredAt: 1_725_000_000_000 + seq,
    kind: 'session_event',
    payload: { type, seq, data },
  };
}

function projectedEvents(projector: DshProjector, record: DshNativeObservation) {
  return projector.project(record).map(({ event: projected }) => projected);
}

describe('DSH event projector', () => {
  it.each([
    [{ kind: 'completed' }, { type: 'turn_completed', provider: 'dsh', turnId: '1' }],
    [{ kind: 'error', error: { message: 'Model attempts exhausted.' } }, {
      type: 'turn_failed', provider: 'dsh', turnId: '1', error: 'Model attempts exhausted.',
    }],
  ])('keeps native retry bookkeeping out of the Timeline and preserves terminal outcome %j', (reason, terminal) => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });
    const records = [
      event('turn-start', 'turn/start', { turn: 1 }),
      event('retry-wait', 'llm/retry', {
        retryId: 'retry-one', turn: 1, step: 1, provider: 'gateway', policyKey: 'network',
        mode: 'normal', retry: 1, maxRetries: 3, delayMs: 100,
        failure: { code: 'network_error', message: 'Transient connection failure.' },
      }, 1),
      event('retry-start', 'llm/retry-started', { retryId: 'retry-one', turn: 1, step: 1, retry: 1 }, 2),
      event('turn-end', 'turn/end', { turn: 1, reason }, 3),
    ];

    expect(records.flatMap((record) => projectedEvents(projector, record))).toEqual([
      { type: 'turn_started', provider: 'dsh', turnId: '1' }, terminal,
    ]);
  });

  it('projects native message and reasoning content as string Timeline items', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    const user = projectedEvents(projector, event('user-1', 'user/message', {
      id: 'message-1', turn: 1, source: { kind: 'user', rpcId: 'web-message-1' }, content: [{ type: 'text', text: '**Hello**' }],
    }));
    const reasoning = projectedEvents(projector, event('reasoning-1', 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Checking' },
    }, 1));
    const assistant = projectedEvents(projector, event('assistant-1', 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Done.' },
    }, 2));

    expect(user).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '1',
      item: { type: 'user_message', messageId: 'message-1', text: '**Hello**' },
    }]);
    expect(reasoning).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '1', item: { type: 'reasoning', text: 'Checking' },
    }]);
    expect(assistant).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '1',
      item: { type: 'assistant_message', messageId: 'assistant:1:1', text: 'Done.' },
    }]);
  });

  it('silently consumes known injected context without impersonating the user', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });
    const sources = [
      {
        recordId: 'plan-mode-notice',
        source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice' },
        text: 'The user switched this session to plan mode.',
      },
      {
        recordId: 'skill-catalog',
        source: { kind: 'skill-catalog' },
        text: '<available_skills>...</available_skills>',
      },
      {
        recordId: 'workspace-instructions',
        source: {
          kind: 'agent-instructions', form: 'instructions', baseline: true,
          changes: [{ action: 'set', scope: 'workspace', path: 'AGENTS.md', digest: 'instructions-digest' }],
        },
        text: '<system-reminder>Workspace instructions for the model.</system-reminder>',
      },
    ];

    for (const [index, source] of sources.entries()) {
      const output = projectedEvents(projector, event(source.recordId, 'user/message', {
        id: source.recordId,
        turn: 1,
        source: source.source,
        content: [{ type: 'text', text: source.text }],
      }, index));

      expect(output).toEqual([]);
    }
  });

  it('keeps unknown injected message sources visibly diagnostic without impersonating the user', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });
    const sources = [
      {
        recordId: 'model-context',
        source: { kind: 'model', model: 'deepseek-chat' },
        text: 'Model-owned context.',
        expectedKind: 'model',
      },
      {
        recordId: 'future-context',
        source: { kind: 'workflow', workflow: 'future-controller' },
        text: 'Future injected context.',
        expectedKind: 'workflow',
      },
    ];

    for (const [index, source] of sources.entries()) {
      const output = projectedEvents(projector, event(source.recordId, 'user/message', {
        id: source.recordId,
        turn: 1,
        source: source.source,
        content: [{ type: 'text', text: source.text }],
      }, index));

      expect(output).toEqual([{
        type: 'timeline', provider: 'dsh', turnId: '1',
        item: { type: 'error', message: `Unsupported DSH user/message source ${source.expectedKind}.` },
      }]);
      expect(output).not.toContainEqual(expect.objectContaining({
        item: expect.objectContaining({ type: 'user_message' }),
      }));
    }

    expect(projectedEvents(projector, event('tool-context', 'user/message', {
      id: 'tool-context', turn: 1, source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'text', text: 'Tool result context.' }],
    }, sources.length))).toEqual([]);
  });

  it.each([
    ['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] }],
    ['step/start', { turn: 1, step: 1 }],
    ['step/end', { turn: 1, step: 1 }],
    ['tool-call-chunks', { turn: 1, step: 1, chunks: [] }],
    ['request/header', { header: { config: {} }, reason: 'initial' }],
    ['agent-preset/selected', { agentPreset: 'standard' }],
    ['request/context', { provider: 'deepseek-official', model: 'deepseek-chat' }],
    ['session/end-seed', {}],
    ['session/title', { title: 'Greeting' }],
    ['session/title-llm-request', { provider: 'deepseek-official', model: 'deepseek-chat' }],
    ['approval/asked', { id: 'approval-1', toolName: 'bash', callId: 'call-1' }],
    ['approval/decided', { id: 'approval-1', outcome: 'approved' }],
    ['permission/preset', { preset: 'default' }],
    ['sandbox/mode', { mode: 'workspace-write' }],
    ['approval/policy', { policy: 'on-request' }],
  ])('does not turn the %s log-only record into a Timeline error', (type, data) => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    expect(projectedEvents(projector, event(`policy:${type}`, type, data))).toEqual([]);
  });

  it('projects native planning changes with the complete runtime identity', () => {
    const projector = new DshProjector({
      sessionId: 'session-1', tools: { get: () => undefined },
      runtimeInfo: () => ({
        providerId: 'dsh', sessionId: 'session-1', status: 'running',
        cwd: '/workspace', model: 'model-1', planning: { active: false, requested: false },
      }),
    });
    expect(projectedEvents(projector, event('mode-off', 'plan/mode', { active: false }))).toEqual([{
      type: 'runtime_updated', provider: 'dsh', runtimeInfo: {
        providerId: 'dsh', sessionId: 'session-1', status: 'running',
        cwd: '/workspace', model: 'model-1', planning: { active: false },
      },
    }]);
    expect(projectedEvents(projector, {
      recordId: 'revision-feedback', occurredAt: 9, kind: 'interaction_resolved',
      payload: { requestId: 'review-1', response: { kind: 'plan_approval', action: 'reject', feedback: 'Add tests.' } },
    })).toMatchObject([{ type: 'interaction_resolved', response: { feedback: 'Add tests.' } }]);
  });

  it('omits successful command lifecycle while retaining failed command feedback', () => {
    const projector = new DshProjector({
      sessionId: 'session-1', tools: { get: () => undefined },
      runtimeInfo: () => ({ providerId: 'dsh', sessionId: 'session-1', status: 'idle' as const, planning: { active: true } }),
    });

    expect(projectedEvents(projector, event('plan-command', 'command/run', {
      commandId: 'command-1', name: 'plan', args: ' off', source: { kind: 'user' },
    }))).toEqual([]);
    expect(projectedEvents(projector, event('plan-mode', 'plan/mode', { active: false }))).toEqual([{
      type: 'runtime_updated', provider: 'dsh',
      runtimeInfo: { providerId: 'dsh', sessionId: 'session-1', status: 'idle', planning: { active: false } },
    }]);
    expect(projectedEvents(projector, event('plan-command-done', 'command/done', {
      commandId: 'command-1', kind: 'success',
    }))).toEqual([]);
    expect(projectedEvents(projector, event('plan-command-failed', 'command/done', {
      commandId: 'command-2', kind: 'error', text: 'Plan mode cannot change while a turn is running.',
    }))).toEqual([{
      type: 'timeline', provider: 'dsh',
      item: { type: 'error', message: 'DSH command failed: Plan mode cannot change while a turn is running.' },
    }]);
  });

  it('publishes the effective request model without exposing native request configuration', () => {
    const projector = new DshProjector({
      sessionId: 'session-1', tools: { get: () => undefined },
      runtimeInfo: () => ({
        providerId: 'dsh', sessionId: 'session-1', status: 'running',
        cwd: '/workspace', model: 'previous-model', planning: { active: true },
      }),
    });
    expect(projectedEvents(projector, event('model-changed', 'request/header', {
      reason: 'change',
      header: { config: { provider: 'gateway', model: 'selected-model', headers: { authorization: 'private-header' } }, system: 'private-system-prompt' },
    }))).toEqual([{
      type: 'runtime_updated', provider: 'dsh', runtimeInfo: {
        providerId: 'dsh', sessionId: 'session-1', status: 'running',
        cwd: '/workspace', model: 'selected-model', planning: { active: true },
      },
    }]);
  });

  it('does not duplicate assistant tool-call content already projected by tool/call', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    expect(projectedEvents(projector, event('assistant-tool-call', 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'text', text: 'Checking the workspace.' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
        ],
      },
    }))).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '1',
      item: {
        type: 'assistant_message', messageId: 'assistant:1:1', text: 'Checking the workspace.',
      },
    }]);
  });

  it('projects tool lifecycle, todo snapshots, usage, and turn lifecycle', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    expect(projectedEvents(projector, event('turn-start', 'turn/start', { turn: 7 }))).toEqual([
      { type: 'turn_started', provider: 'dsh', turnId: '7' },
    ]);
    expect(projectedEvents(projector, event('tool-call', 'tool/call', {
      turn: 7, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}',
    }, 1))).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '7',
      item: {
        type: 'tool_call', callId: 'call-1', name: 'bash', status: 'running', error: null,
        detail: { type: 'shell', command: 'pwd' },
      },
    }]);
    expect(projectedEvents(projector, event('tool-result', 'tool/result', {
      turn: 7, callId: 'call-1', message: { content: [{ content: [{ type: 'text', text: '/workspace' }] }] },
    }, 2))).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '7',
      item: {
        type: 'tool_call', callId: 'call-1', name: 'bash', status: 'completed', error: null,
        detail: { type: 'shell', command: 'pwd' },
      },
    }]);
    expect(projectedEvents(projector, event('todo', 'todo/write', {
      turn: 7,
      todos: [
        { content: 'Inspect', status: 'completed' },
        { content: 'Report', status: 'in_progress', activeForm: 'Reporting' },
      ],
    }, 3))).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '7',
      item: { type: 'todo', items: [
        { text: 'Inspect', completed: true, status: 'completed' },
        { text: 'Report', completed: false, status: 'in_progress', activeForm: 'Reporting' },
      ] },
    }]);
    expect(projectedEvents(projector, event('usage', 'assistant/chunk', {
      turn: 7, step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } },
    }, 4))).toEqual([{
      type: 'usage_updated', provider: 'dsh', turnId: '7',
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 },
    }]);
    expect(projectedEvents(projector, event('turn-end', 'turn/end', {
      turn: 7, reason: { kind: 'completed' },
    }, 5))).toEqual([{ type: 'turn_completed', provider: 'dsh', turnId: '7' }]);
  });

  it('keeps corrections and unknown native meaning visibly diagnostic', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    projectedEvents(projector, event('assistant-original', 'assistant/message', {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Original.' }] },
    }));
    const correction = projectedEvents(projector, event('assistant-correction', 'assistant/correction', {
      turn: 1, step: 1, revision: 2, content: [{ type: 'text', text: 'Corrected.' }],
    }, 1));
    const unknown = projectedEvents(projector, event('future-event', 'future/event', { opaque: true }, 2));

    expect(correction).toEqual([
      {
        type: 'timeline', provider: 'dsh', turnId: '1',
        item: { type: 'error', message: 'DSH corrected assistant output; the correction is shown as a new message.' },
      },
      {
        type: 'timeline', provider: 'dsh', turnId: '1',
        item: { type: 'assistant_message', messageId: 'assistant:1:1:correction:2', text: 'Corrected.' },
      },
    ]);
    expect(unknown).toEqual([{
      type: 'timeline', provider: 'dsh',
      item: { type: 'error', message: 'Unsupported DSH event future/event.' },
    }]);
  });

  it('records only complete image attachment references as readable session resources', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });
    const reference = {
      attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'plot.png',
    };

    const output = projectedEvents(projector, event('assistant-image', 'assistant/message', {
      turn: 1, step: 1,
      message: { content: [{ type: 'text', text: 'Plot: ' }, { type: 'image', attachment: reference }] },
    }));

    expect(output).toEqual([{
      type: 'timeline', provider: 'dsh', turnId: '1',
      item: {
        type: 'assistant_message', messageId: 'assistant:1:1',
        text: 'Plot: ![plot.png](dsh-attachment:image-1)',
      },
    }]);
    expect(projector.imageReference('dsh-attachment:image-1')).toEqual(reference);
    expect(projector.imageReference('dsh-attachment:other')).toBeUndefined();
  });

  it('projects a successful write with a stable opaque read identity and visible file name', () => {
    const firstReader = new DshGeneratedResourceReader('session-1', () => []);
    const secondReader = new DshGeneratedResourceReader('session-1', () => []);
    const createProjector = (reader: DshGeneratedResourceReader) => new DshProjector({
      sessionId: 'session-1',
      tools: { get: () => undefined },
      referenceGeneratedResource: (locator, revisionKey) => reader.reference(locator, revisionKey),
    });
    const projectWrite = (projector: DshProjector) => {
      projector.project(event('write-call', 'tool/call', {
        turn: 1,
        callId: 'write-one',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'reports/result.txt', content: 'first revision\n' }),
      }));
      return projector.project(event('write-result', 'tool/result', {
        turn: 1,
        callId: 'write-one',
        message: { content: [{ type: 'text', text: 'Wrote file.' }] },
      }, 1))[0];
    };

    const first = projectWrite(createProjector(firstReader));
    const replayed = projectWrite(createProjector(secondReader));

    expect(first?.event).toMatchObject({
      type: 'timeline',
      item: { type: 'tool_call', status: 'completed', detail: { type: 'write', filePath: 'reports/result.txt' } },
    });
    expect(first?.resourceReferences).toEqual([{
      locator: 'reports/result.txt',
      readLocator: expect.stringMatching(/^dsh-generated:[a-f0-9]{64}$/),
    }]);
    expect(replayed?.resourceReferences).toEqual(first?.resourceReferences);
    expect(first?.resourceReferences?.[0]?.readLocator).not.toContain('reports/result.txt');
  });

  it('projects every complete interaction request and response', () => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });
    const observations: DshNativeObservation[] = [
      {
        recordId: 'question-request', occurredAt: 1, kind: 'interaction_requested',
        payload: {
          request: {
            kind: 'question', requestId: 'question-1', questions: [{
              questionId: 'target', header: 'Target', prompt: 'Choose a target.', description: '',
              required: true, selection: 'multiple',
              options: [{ value: 'api', label: 'API', description: '' }],
              allowCustomText: true, allowDismiss: false,
            }],
          },
        },
      },
      {
        recordId: 'plan-request', occurredAt: 2, kind: 'interaction_requested',
        payload: {
          request: {
            kind: 'plan_approval', requestId: 'plan-1', plan: '',
            allowedActions: ['approve', 'approve_and_resume', 'reject'],
          },
        },
      },
      {
        recordId: 'tool-request', occurredAt: 3, kind: 'interaction_requested',
        payload: {
          request: {
            kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell', summary: '',
            detail: { type: 'shell', command: 'pwd', cwd: '/workspace' },
            allowedDecisions: ['allow', 'deny'], allowScopes: ['once', 'session'],
          },
        },
      },
      {
        recordId: 'question-response', occurredAt: 4, kind: 'interaction_resolved',
        payload: {
          requestId: 'question-1',
          response: {
            kind: 'question', dismissed: false,
            answers: [{ questionId: 'target', selectedValues: ['api'], customText: '' }],
          },
        },
      },
      {
        recordId: 'plan-response', occurredAt: 5, kind: 'interaction_resolved',
        payload: { requestId: 'plan-1', response: { kind: 'plan_approval', action: 'approve_and_resume' } },
      },
      {
        recordId: 'tool-allow-response', occurredAt: 6, kind: 'interaction_resolved',
        payload: { requestId: 'tool-1', response: { kind: 'tool_approval', decision: 'allow', scope: 'session' } },
      },
      {
        recordId: 'tool-deny-response', occurredAt: 7, kind: 'interaction_resolved',
        payload: { requestId: 'tool-2', response: { kind: 'tool_approval', decision: 'deny', message: '' } },
      },
    ];

    expect(observations.flatMap((observation) => projectedEvents(projector, observation)).map(({ type }) => type)).toEqual([
      'interaction_requested', 'interaction_requested', 'interaction_requested',
      'interaction_resolved', 'interaction_resolved', 'interaction_resolved', 'interaction_resolved',
    ]);
  });

  it.each([
    { type: 'shell', command: 'pwd', cwd: '/workspace' },
    { type: 'read', filePath: 'input.txt' },
    { type: 'edit', filePath: 'input.txt' },
    { type: 'write', filePath: 'output.txt' },
    { type: 'search', query: 'interaction' },
    { type: 'fetch', url: 'https://example.test/data' },
    { type: 'other', description: 'Provider-defined operation' },
  ])('accepts the complete $type tool detail variant', (detail) => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    const output = projectedEvents(projector, {
      recordId: `tool-detail:${detail.type}`, occurredAt: 1, kind: 'interaction_requested',
      payload: {
        request: {
          kind: 'tool_approval', requestId: `tool-${detail.type}`, toolCallId: 'call-1',
          toolName: 'tool', summary: '', detail, allowedDecisions: ['allow'], allowScopes: [],
        },
      },
    });

    expect(output).toEqual([expect.objectContaining({ type: 'interaction_requested' })]);
  });

  it.each([
    ['question request without an id', 'interaction_requested', { request: { kind: 'question', requestId: '', questions: [] } }],
    ['question request without questions', 'interaction_requested', { request: { kind: 'question', requestId: 'q-1' } }],
    ['question request with no questions', 'interaction_requested', { request: { kind: 'question', requestId: 'q-1', questions: [] } }],
    ['question request with non-array questions', 'interaction_requested', {
      request: { kind: 'question', requestId: 'q-1', questions: {} },
    }],
    ['question request with an invalid question field', 'interaction_requested', {
      request: { kind: 'question', requestId: 'q-1', questions: [{
        questionId: 'target', header: 'Target', required: true, selection: 'single', options: [],
        allowCustomText: false, allowDismiss: false,
      }] },
    }],
    ['question request with an invalid selection', 'interaction_requested', {
      request: { kind: 'question', requestId: 'q-1', questions: [{
        questionId: 'target', header: 'Target', prompt: 'Choose.', required: true, selection: 'any', options: [],
        allowCustomText: false, allowDismiss: false,
      }] },
    }],
    ['question request with invalid options', 'interaction_requested', {
      request: { kind: 'question', requestId: 'q-1', questions: [{
        questionId: 'target', header: 'Target', prompt: 'Choose.', required: true, selection: 'single',
        options: [{ value: '', label: 'API' }], allowCustomText: false, allowDismiss: false,
      }] },
    }],
    ['plan request without its plan', 'interaction_requested', {
      request: { kind: 'plan_approval', requestId: 'plan-1', allowedActions: ['approve'] },
    }],
    ['plan request with an invalid action', 'interaction_requested', {
      request: { kind: 'plan_approval', requestId: 'plan-1', plan: 'Ship.', allowedActions: ['later'] },
    }],
    ['plan request with non-array actions', 'interaction_requested', {
      request: { kind: 'plan_approval', requestId: 'plan-1', plan: 'Ship.', allowedActions: 'approve' },
    }],
    ['plan request with duplicate actions', 'interaction_requested', {
      request: { kind: 'plan_approval', requestId: 'plan-1', plan: 'Ship.', allowedActions: ['approve', 'approve'] },
    }],
    ['tool request without its summary', 'interaction_requested', {
      request: {
        kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell',
        detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow'], allowScopes: ['once'],
      },
    }],
    ['tool request with an incomplete detail', 'interaction_requested', {
      request: {
        kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell', summary: 'Run.',
        detail: { type: 'shell' }, allowedDecisions: ['allow'], allowScopes: ['once'],
      },
    }],
    ['tool request with an invalid decision', 'interaction_requested', {
      request: {
        kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell', summary: 'Run.',
        detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['ask'], allowScopes: ['once'],
      },
    }],
    ['tool request with no decisions', 'interaction_requested', {
      request: {
        kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell', summary: 'Run.',
        detail: { type: 'shell', command: 'pwd' }, allowedDecisions: [], allowScopes: ['once'],
      },
    }],
    ['tool request with an invalid scope', 'interaction_requested', {
      request: {
        kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell', summary: 'Run.',
        detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow'], allowScopes: ['always'],
      },
    }],
    ['tool request with an extra field', 'interaction_requested', {
      request: {
        kind: 'tool_approval', requestId: 'tool-1', toolCallId: 'call-1', toolName: 'shell', summary: 'Run.',
        detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow'], allowScopes: ['once'], metadata: {},
      },
    }],
    ['question response without answers', 'interaction_resolved', {
      requestId: 'q-1', response: { kind: 'question' },
    }],
    ['question response with an invalid answer field', 'interaction_resolved', {
      requestId: 'q-1', response: { kind: 'question', answers: [{ questionId: 'target' }] },
    }],
    ['question response with non-array answers', 'interaction_resolved', {
      requestId: 'q-1', response: { kind: 'question', answers: {} },
    }],
    ['question response with duplicate selected values', 'interaction_resolved', {
      requestId: 'q-1', response: {
        kind: 'question', answers: [{ questionId: 'target', selectedValues: ['api', 'api'] }],
      },
    }],
    ['question response with an invalid dismissed flag', 'interaction_resolved', {
      requestId: 'q-1', response: { kind: 'question', answers: [], dismissed: 'yes' },
    }],
    ['plan response with an invalid action', 'interaction_resolved', {
      requestId: 'plan-1', response: { kind: 'plan_approval', action: 'later' },
    }],
    ['tool allow response without a scope', 'interaction_resolved', {
      requestId: 'tool-1', response: { kind: 'tool_approval', decision: 'allow' },
    }],
    ['tool allow response with an invalid scope', 'interaction_resolved', {
      requestId: 'tool-1', response: { kind: 'tool_approval', decision: 'allow', scope: 'always' },
    }],
    ['tool deny response with an allow-only scope', 'interaction_resolved', {
      requestId: 'tool-1', response: { kind: 'tool_approval', decision: 'deny', scope: 'once' },
    }],
    ['tool deny response with an invalid message', 'interaction_resolved', {
      requestId: 'tool-1', response: { kind: 'tool_approval', decision: 'deny', message: false },
    }],
    ['interaction response without a request id', 'interaction_resolved', {
      requestId: '', response: { kind: 'plan_approval', action: 'approve' },
    }],
  ] satisfies Array<[string, DshNativeObservation['kind'], unknown]>)('turns malformed %s into only a Timeline error', (_name, kind, payload) => {
    const projector = new DshProjector({ sessionId: 'session-1', tools: { get: () => undefined } });

    const output = projectedEvents(projector, { recordId: `malformed:${_name}`, occurredAt: 1, kind, payload });

    expect(output).toEqual([{
      type: 'timeline', provider: 'dsh', item: { type: 'error', message: `Unsupported DSH observation ${kind}.` },
    }]);
  });
});
