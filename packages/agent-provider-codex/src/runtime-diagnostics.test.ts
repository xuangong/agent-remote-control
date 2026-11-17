import { expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';

it('keeps successful MCP and hook startup out of conversation history', () => {
  const projector = new CodexEventProjector('thread');
  for (const status of ['starting', 'ready']) expect(projector.projectNotification('mcpServer/startupStatus/updated', { threadId: 'thread', name: 'tools', status })).toBeNull();
  for (const [method, status] of [['hook/started', 'running'], ['hook/completed', 'completed']]) expect(projector.projectNotification(method!, { threadId: 'thread', run: { status } })).toBeNull();
});

it('reports a native startup failure to the diagnostic sink and shows a failing MCP server once, live-only', () => {
  const lines: string[] = [];
  const projector = new CodexEventProjector('thread', { diagnostic: line => lines.push(line) });
  const params = { threadId: 'thread', name: 'tools', status: 'failed', error: 'Connection refused' };
  const [shown, again] = [1, 2].map(() => projector.projectNotifications('mcpServer/startupStatus/updated', params)[0]!);
  expect(shown.itemIdentity).toEqual({ key: 'startup:tools', completes: true, liveOnly: true });
  expect(shown.event).toMatchObject({ type: 'timeline', item: { type: 'error', message: 'tools failed: Connection refused' } });
  expect(again.itemIdentity).toEqual(shown.itemIdentity);
  expect(projector.projectNotifications('hook/completed', { threadId: 'thread', run: { status: 'failed', eventName: 'x' } })).toEqual([]);
  expect(lines.map(line => JSON.parse(line)).slice(0, 1)).toEqual([{ event: 'codex_startup_notice', method: 'mcpServer/startupStatus/updated', name: 'tools', status: 'failed', message: 'Connection refused' }]);
  expect(projector.projectNotifications('mcpServer/startupStatus/updated', { ...params, threadId: 'other' })).toEqual([]);
});
