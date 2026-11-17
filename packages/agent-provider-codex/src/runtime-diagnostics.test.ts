import { expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';

it('keeps successful MCP and hook startup out of conversation history', () => {
  const projector = new CodexEventProjector('thread');
  for (const status of ['starting', 'ready']) expect(projector.projectNotification('mcpServer/startupStatus/updated', { threadId: 'thread', name: 'tools', status })).toBeNull();
  for (const [method, status] of [['hook/started', 'running'], ['hook/completed', 'completed']]) expect(projector.projectNotification(method!, { threadId: 'thread', run: { status } })).toBeNull();
});

it('reports a native startup failure to the diagnostic sink and keeps it out of the timeline', () => {
  const lines: string[] = [];
  const projector = new CodexEventProjector('thread', { diagnostic: line => lines.push(line) });
  const params = { threadId: 'thread', name: 'tools', status: 'failed', error: 'Connection refused' };
  expect(projector.projectNotifications('mcpServer/startupStatus/updated', params)).toEqual([]);
  expect(lines.map(line => JSON.parse(line))).toEqual([{ event: 'codex_startup_notice', method: 'mcpServer/startupStatus/updated', name: 'tools', status: 'failed', message: 'Connection refused' }]);
  expect(projector.projectNotifications('mcpServer/startupStatus/updated', { ...params, threadId: 'other' })).toEqual([]);
  expect(lines).toHaveLength(1);
});
