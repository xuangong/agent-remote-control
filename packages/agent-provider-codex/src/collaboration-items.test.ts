import { describe, expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';

describe('Codex parent-session collaboration observations', () => {
  it('projects a completed delegated tool call with bounded native results', () => {
    const projector = new CodexEventProjector('parent');
    const event = projector.projectNotification('item/completed', { threadId: 'parent', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'delegate', tool: 'spawnAgent', status: 'completed', senderThreadId: 'parent', receiverThreadIds: ['child'], prompt: 'Check results', model: null, reasoningEffort: null,
      agentsStates: { child: { status: 'completed', message: 'All checks passed' } },
    } });
    expect(event).toMatchObject({ event: { type: 'timeline', item: { type: 'tool_call', callId: 'delegate', name: 'agent.spawnAgent', status: 'completed', result: { content: [{ type: 'json', value: { receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed', message: 'All checks passed' } } } }] } } } });
  });
  it('projects activity passively in its parent thread and ignores other threads', () => {
    const projector = new CodexEventProjector('parent');
    const item = { type: 'subAgentActivity', id: 'activity', kind: 'interacted', agentThreadId: 'child', agentPath: '/review' };
    expect(projector.projectNotification('item/started', { threadId: 'parent', item })).toMatchObject({ event: { item: { type: 'tool_call', callId: 'activity', status: 'running', detail: { type: 'other', description: 'Agent /review: interacted' } } } });
    expect(projector.projectNotification('item/completed', { threadId: 'other', item })).toBeNull();
  });
  it('does not treat known goal and discovery notifications as agent errors', () => {
    const projector = new CodexEventProjector('parent');
    for (const method of ['thread/goal/cleared', 'thread/goal/updated', 'skills/changed', 'thread/queue/changed', 'item/mcpToolCall/progress']) expect(projector.projectNotification(method, { threadId: 'parent' })).toBeNull();
    expect(projector.projectNotification('unknown/new', { threadId: 'parent' })).toMatchObject({ event: { item: { type: 'error', message: expect.stringContaining('Unsupported') } } });
  });
});

describe('Codex raw response envelopes', () => {
  it.each(['rawResponseItem/completed', 'rawResponse/completed'])('does not publish private provider payloads from %s as timeline errors', (method) => {
    const projector = new CodexEventProjector('parent');
    expect(projector.projectNotification(method, { threadId: 'parent', item: { type: 'function_call_output', output: 'PRIVATE_ANSWER_SENTINEL' } })).toBeNull();
  });
});

it('normalizes activity navigation identically in live and saved history', () => {
  const projector = new CodexEventProjector('parent');
  const item = { type: 'subAgentActivity', id: 'activity', kind: 'interacted', agentThreadId: 'child-id', agentPath: '/root/review' };
  const live = projector.projectNotification('item/completed', { threadId: 'parent', turnId: 'turn', item });
  expect(live?.event).toMatchObject({ item: { detail: { sessionReference: { nativeSessionId: 'child-id', title: '/root/review' } } } });
  expect(projector.projectHistoryItem(item, 'turn')?.event).toEqual(live?.event);
  expect(projector.projectHistoryItem({ ...item, agentThreadId: undefined })?.event).not.toHaveProperty('item.detail.sessionReference');
});

it('shows every explicit wait target before completion and preserves targets in history', () => {
  const projector = new CodexEventProjector('parent');
  const item = { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', receiverThreadIds: ['review', 'tests', 'review'], agentsStates: {} };
  const detail = { type: 'other', description: 'Waiting for agent updates:', sessionReferences: [
    { nativeSessionId: 'review', title: 'review' }, { nativeSessionId: 'tests', title: 'tests' },
  ] };
  const started = projector.projectNotification('item/started', { threadId: 'parent', item });
  expect(started?.event).toMatchObject({ item: { detail, status: 'running' } });
  const completed = { ...item, status: 'completed', agentsStates: { review: { status: 'completed' } } };
  const live = projector.projectNotification('item/completed', { threadId: 'parent', item: completed });
  expect(live?.event).toMatchObject({ item: { detail: { ...detail, description: 'Waited for agent updates:' } } });
  expect(projector.projectHistoryItem(completed)?.event).toEqual(live?.event);
});

it('distinguishes an untargeted mailbox wait from missing target metadata', () => {
  const projector = new CodexEventProjector('parent');
  const item = { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed', agentsStates: {} };
  expect(projector.projectHistoryItem({ ...item, receiverThreadIds: [] })?.event).toMatchObject({ item: {
    detail: { type: 'other', description: 'Waited for updates from any sub-agent' },
  } });
  expect(projector.projectHistoryItem(item)?.event).toMatchObject({ item: {
    detail: { description: 'Waited for agent updates (target unavailable)' },
  } });
});


it('shows a single explicit wait target and does not invent targets from returned agent states', () => {
  const projector = new CodexEventProjector('parent');
  const item = { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', agentsStates: { unrelated: { status: 'completed' } } };
  expect(projector.projectNotification('item/started', { threadId: 'parent', item: { ...item, receiverThreadIds: ['child'] } })?.event).toMatchObject({ item: {
    detail: { sessionReferences: [{ nativeSessionId: 'child', title: 'child' }] },
  } });
  const event = projector.projectNotification('item/started', { threadId: 'parent', item: { ...item, receiverThreadIds: [] } })?.event;
  expect(event).toMatchObject({ item: { detail: { description: 'Waiting for updates from any sub-agent' } } });
  expect(event).not.toHaveProperty('item.detail.sessionReferences');
});
