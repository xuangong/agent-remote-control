import { expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';

it('keeps successful MCP and hook startup out of conversation history', () => {
  const projector = new CodexEventProjector('thread');
  for (const status of ['starting', 'ready']) expect(projector.projectNotification('mcpServer/startupStatus/updated', { threadId: 'thread', name: 'tools', status })).toBeNull();
  for (const [method, status] of [['hook/started', 'running'], ['hook/completed', 'completed']]) expect(projector.projectNotification(method!, { threadId: 'thread', run: { status } })).toBeNull();
});

it('retains native startup failures as diagnostics and filters other threads', () => {
  const projector = new CodexEventProjector('thread');
  const params = { threadId: 'thread', name: 'tools', status: 'failed', error: 'Connection refused' };
  expect(projector.projectNotification('mcpServer/startupStatus/updated', params)).toMatchObject({ event: { type: 'timeline', item: { type: 'error', message: 'tools failed: Connection refused' } } });
  expect(projector.projectNotification('mcpServer/startupStatus/updated', { ...params, threadId: 'other' })).toBeNull();
});
