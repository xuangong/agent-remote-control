import { describe, expect, it } from 'vitest';

import { CodexEventProjector } from './projector.js';

describe('CodexEventProjector', () => {
  it('uses the native turn start timestamp for elapsed time instead of notification delivery time', () => {
    const projector = new CodexEventProjector('thread-1');
    const observation = projector.projectNotification('turn/started', {
      threadId: 'thread-1', turn: { id: 'turn-1', startedAt: 1_789_000_000 },
    });
    expect(observation?.occurredAt).toBe(1_789_000_000_000);
    expect(observation?.event).toEqual({ type: 'turn_started', provider: 'codex', turnId: 'turn-1' });
  });

  it('projects native thread startup into provider lifecycle', () => {
    const projector = new CodexEventProjector('thread-1');

    const observation = projector.projectNotification('thread/started', {
      thread: { id: 'thread-1' },
    });

    expect(observation).toEqual({
      type: 'observation',
      sourceKey: 'thread:thread-1:started',
      occurredAt: expect.any(Number),
      delivery: 'live',
      event: { type: 'thread_started', provider: 'codex', sessionId: 'thread-1' },
    });
  });

  it('projects assistant and reasoning deltas as incremental timeline text', () => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'Hello',
    })).toMatchObject({
      event: {
        type: 'timeline',
        item: { type: 'assistant_message', messageId: 'assistant-1', text: 'Hello' },
      },
    });
    expect(projector.projectNotification('item/reasoning/summaryTextDelta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: 'Think',
    })).toMatchObject({
      event: { type: 'timeline', item: { type: 'reasoning', text: 'Think' } },
    });
  });

  it('preserves corrected final text without appending it to the streamed message', () => {
    const projector = new CodexEventProjector('thread-1');

    projector.projectNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'helo',
    });

    expect(projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-1', text: 'hello' },
    })).toMatchObject({
      event: {
        type: 'timeline',
        item: {
          type: 'assistant_message',
          messageId: expect.stringMatching(/^assistant-1:correction:[0-9a-f]{8}$/),
          text: 'hello',
        },
      },
    });
  });

  it('retires streamed state after projecting a corrected completion', () => {
    const projector = new CodexEventProjector('thread-1');

    projector.projectNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'helo',
    });
    projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-1', text: 'hello' },
    });
    projector.projectNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-2', itemId: 'assistant-1', delta: 'Reused ID',
    });

    expect(projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-2',
      item: { type: 'agentMessage', id: 'assistant-1', text: 'Reused ID' },
    })).toBeNull();
  });

  it('uses stable source identity when a native delta is delivered again', () => {
    const projector = new CodexEventProjector('thread-1');
    const params = {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'Hello',
    };

    const first = projector.projectNotification('item/agentMessage/delta', params);
    const replay = projector.projectNotification('item/agentMessage/delta', params);

    expect(replay?.sourceKey).toBe(first?.sourceKey);
    expect(projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-1', text: 'Hello' },
    })).toBeNull();
  });

  it.each([
    ['item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1' }],
    ['item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage' } }],
    ['turn/started', { threadId: 'thread-1' }],
    ['turn/completed', { threadId: 'thread-1', turn: {} }],
    ['turn/plan/updated', { threadId: 'thread-1', turnId: 'turn-1' }],
    ['thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {} }],
  ])('projects malformed known notification %s as a visible diagnostic', (method, params) => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification(method, params)).toMatchObject({
      event: {
        type: 'timeline',
        item: { type: 'error', message: expect.stringContaining(`Invalid Codex notification ${method}`) },
      },
    });
  });

  it('projects plan deltas as one appendable assistant message', () => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification('item/plan/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'plan-1', delta: '# Plan',
    })).toMatchObject({
      event: {
        type: 'timeline',
        item: { type: 'assistant_message', messageId: 'plan-1', text: '# Plan' },
      },
    });
    expect(projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { type: 'plan', id: 'plan-1', text: '# Plan' },
    })).toBeNull();
  });

  it.each([
    ['item/commandExecution/outputDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', delta: 'output' }],
    ['item/commandExecution/terminalInteraction', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', processId: 'process-1', stdin: 'yes\n',
    }],
    ['item/fileChange/patchUpdated', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', changes: [] }],
    ['item/reasoning/textDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: 'private reasoning' }],
    ['item/reasoning/summaryPartAdded', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0 }],
    ['thread/name/updated', { threadId: 'thread-1', threadName: 'Readable session name' }],
    ['turn/diff/updated', { threadId: 'thread-1', turnId: 'turn-1', diff: '+change' }],
  ])('does not turn the known %s telemetry notification into an Agent error', (method, params) => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification(method, params)).toBeNull();
  });

  it('uses canonical item lifecycle notifications and ignores legacy mirrors', () => {
    const projector = new CodexEventProjector('thread-1');
    const item = {
      type: 'commandExecution',
      id: 'command-1',
      command: 'pwd',
      cwd: '/workspace',
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
    };

    expect(projector.projectNotification('item/started', {
      threadId: 'thread-1', turnId: 'turn-1', item,
    })).toMatchObject({
      sourceKey: 'item:command-1:started',
      event: {
        type: 'timeline',
        item: {
          type: 'tool_call', callId: 'command-1', name: 'command', status: 'running',
          detail: { type: 'shell', command: 'pwd', cwd: '/workspace' }, error: null,
        },
      },
    });
    expect(projector.projectNotification('codex/event/item_started', { msg: { item } })).toBeNull();
    expect(projector.projectNotification('codex/event/item_completed', { msg: { item } })).toBeNull();
  });

  it('ignores Codex remote control availability notifications', () => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification('remoteControl/status/changed', {
      status: 'disabled',
      serverName: 'developer-machine.local',
      installationId: 'installation-1',
      environmentId: null,
    })).toBeNull();
  });

  it.each([
    ['thread/settings/updated', { threadId: 'thread-1', threadSettings: { cwd: '/workspace' } }],
    ['thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } }],
    ['serverRequest/resolved', { threadId: 'thread-1', requestId: 7 }],
    ['account/rateLimits/updated', { rateLimits: { limitId: 'codex' } }],
    ['warning', { threadId: 'thread-1', message: 'Model metadata is unavailable.' }],
  ])('does not misclassify the known %s notification as an Agent error', (method, params) => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification(method, params)).toBeNull();
  });

  it.each([
    [
      { type: 'fileChange', id: 'file-1', changes: [{ path: '/workspace/a.ts', kind: 'update' }], status: 'completed' },
      { name: 'file_change', detail: { type: 'edit', filePath: '/workspace/a.ts' }, status: 'completed' },
    ],
    [
      { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', status: 'failed', arguments: { q: 'x' }, error: { message: 'offline' } },
      { name: 'docs.search', detail: { type: 'other', description: 'MCP tool docs.search' }, status: 'failed', error: 'offline' },
    ],
    [
      { type: 'webSearch', id: 'web-1', query: 'Borgee', status: 'completed' },
      { name: 'web_search', detail: { type: 'search', query: 'Borgee' }, status: 'completed' },
    ],
  ])('projects completed tool item %#', (item, expected) => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', item,
    })).toMatchObject({ event: { type: 'timeline', item: expected } });
  });

  it('projects plan, usage, lifecycle, and compaction state', () => {
    const projector = new CodexEventProjector('thread-1');

    expect(projector.projectNotification('turn/plan/updated', {
      threadId: 'thread-1', turnId: 'turn-1', plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Implement', status: 'inProgress' },
      ],
    })).toMatchObject({
      event: { type: 'timeline', item: { type: 'todo', items: [
        { text: 'Inspect', completed: true, status: 'completed' },
        { text: 'Implement', completed: false, status: 'in_progress' },
      ] } },
    });
    expect(projector.projectNotification('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {
        total: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, totalTokens: 10 },
        modelContextWindow: 100,
      },
    })).toMatchObject({
      event: { type: 'usage_updated', usage: {
        inputTokens: 7, cachedInputTokens: 2, outputTokens: 3,
        contextWindowMaxTokens: 100, contextWindowUsedTokens: 10,
      } },
    });
    expect(projector.projectNotification('turn/started', {
      threadId: 'thread-1', turn: { id: 'turn-1' },
    })).toMatchObject({ event: { type: 'turn_started', turnId: 'turn-1' } });
    expect(projector.projectNotification('thread/compacted', {
      threadId: 'thread-1', turnId: 'turn-1',
    })).toMatchObject({ event: { type: 'timeline', item: { type: 'compaction', status: 'completed' } } });
  });

  it('projects unsupported notifications and live items as bounded diagnostics', () => {
    const projector = new CodexEventProjector('thread-1');
    const notification = projector.projectNotification('thread/futureState/updated', {
      threadId: 'thread-1', futureState: 'x'.repeat(2_000),
    });
    const item = projector.projectNotification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { type: 'futureTool', id: 'future-1', payload: 'y'.repeat(2_000) },
    });

    expect(notification).toMatchObject({
      event: { type: 'timeline', item: { type: 'error' } },
    });
    expect(item).toMatchObject({
      event: { type: 'timeline', item: { type: 'error' } },
    });
    if (notification?.event.type !== 'timeline' || notification.event.item.type !== 'error') {
      throw new Error('Expected an unsupported notification diagnostic');
    }
    if (item?.event.type !== 'timeline' || item.event.item.type !== 'error') {
      throw new Error('Expected an unsupported item diagnostic');
    }
    expect(notification.event.item.message).toContain('thread/futureState/updated');
    expect(notification.event.item.message.length).toBeLessThanOrEqual(640);
    expect(item.event.item.message).toContain('futureTool');
    expect(item.event.item.message.length).toBeLessThanOrEqual(640);
  });
});
