import { expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';

it('retains successful and failed command output identically in live and native history', () => {
  for (const exitCode of [0, 2]) {
    const item = { type: 'commandExecution', id: 'call', command: 'echo hello', status: exitCode ? 'failed' : 'completed', aggregatedOutput: 'hello\n', exitCode, durationMs: 15 };
    const projector = new CodexEventProjector('thread');
    const live = projector.projectNotification('item/completed', { threadId: 'thread', turnId: 'turn', item });
    const history = projector.projectHistoryItem(item, 'turn');
    expect(live?.event).toMatchObject({ item: { callId: 'call', result: { content: [{ type: 'text', stream: 'combined', text: 'hello\n' }], exitCode, durationMs: 15 } } });
    expect(history?.event).toEqual(live?.event);
  }
});

it('retains MCP text and structured results and full file changes', () => {
  const projector = new CodexEventProjector('thread');
  const result = { content: [{ type: 'text', text: 'Found it' }], structuredContent: { count: 2 } };
  expect(projector.projectHistoryItem({ type: 'mcpToolCall', id: 'mcp', server: 'docs', tool: 'search', status: 'completed', result })?.event).toMatchObject({ item: { result: { content: [{ type: 'text', text: 'Found it' }, { type: 'json', value: { count: 2 } }] } } });
  const changes = [{ path: 'a.ts', diff: '+hello' }, { path: 'b.ts', diff: '-bye' }];
  expect(projector.projectHistoryItem({ type: 'fileChange', id: 'edit', changes, status: 'completed' })?.event).toMatchObject({ item: { result: { content: [{ type: 'json', value: {
    format: 'file_changes', version: 1, files: changes.map(change => ({ ...change, kind: 'unknown' })),
  } }] } } });
});

it('normalizes native file operations identically in live and history', () => {
  const changes = [
    { path: 'add.ts', kind: { type: 'add' }, diff: '+new' },
    { path: 'delete.ts', kind: { type: 'delete' }, diff: '-old' },
    { path: 'edit.ts', kind: { type: 'update', move_path: null }, diff: '-old\n+new' },
    { path: 'before.ts', kind: { type: 'update', move_path: 'after.ts' }, diff: '' },
  ];
  const item = { type: 'fileChange', id: 'files', changes, status: 'completed' };
  const projector = new CodexEventProjector('thread');
  const live = projector.projectNotification('item/completed', { threadId: 'thread', turnId: 'turn', item });
  expect(projector.projectHistoryItem(item, 'turn')?.event).toEqual(live?.event);
  expect(live?.event).toMatchObject({ item: { result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [
    { path: 'add.ts', kind: 'added', diff: '+new' }, { path: 'delete.ts', kind: 'deleted', diff: '-old' },
    { path: 'edit.ts', kind: 'modified', diff: '-old\n+new' }, { path: 'after.ts', previousPath: 'before.ts', kind: 'renamed', diff: '' },
  ] } }] } } });
});

it('retains web search results in live and history without inventing a started result', () => {
  const projector = new CodexEventProjector('thread');
  const started = { type: 'webSearch', id: 'search', query: 'protocol', action: null };
  const event = projector.projectNotification('item/started', { threadId: 'thread', turnId: 'turn', item: started });
  expect(event?.event).toMatchObject({ item: { status: 'running' } });
  expect(event?.event).not.toHaveProperty('item.result');
  const results = [{ type: 'text_result', ref_id: 'ref', url: 'https://example.com', title: 'Protocol', snippet: 'Search result body' }];
  for (const action of [null, { type: 'search', query: 'protocol' }]) {
    const item = { ...started, action, results };
    const live = projector.projectNotification('item/completed', { threadId: 'thread', turnId: 'turn', item });
    const history = projector.projectHistoryItem(item, 'turn');
    expect(live?.event).toMatchObject({ item: { result: { content: [{ type: 'json', value: { ...(action ? { action } : {}), results } }] } } });
    expect(history?.event).toEqual(live?.event);
  }
  expect(projector.projectHistoryItem(started, 'turn')?.event).not.toHaveProperty('item.result');
});
