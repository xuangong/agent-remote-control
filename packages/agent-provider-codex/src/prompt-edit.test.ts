import { expect, it } from 'vitest';
import { CodexAppServerTransport } from './app-server-transport.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';
import { preparePromptEdit } from './prompt-edit.js';

const prompt = { id: 'message-2', type: 'userMessage', content: [{ type: 'text', text: 'Edit me', text_elements: [] }] };
const target = { nativeSessionId: 'source', turnId: 'turn-2', messageId: 'message-2' };
function fixture(turns: unknown[], nextCursor: string | null = null) {
  const app = createScriptedAppServer({
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp', turns: [] } }),
    'thread/turns/list': params => (params as { cursor?: string }).cursor
      ? { data: [{ id: 'turn-1', status: 'completed', items: [] }], nextCursor: null }
      : { data: turns, nextCursor },
  });
  return { app, transport: new CodexAppServerTransport(app.child) };
}
it('resolves a stable native boundary without modifying the source', async () => {
  const { app, transport } = fixture([{ id: 'turn-2', status: 'completed', items: [prompt] }], 'older');
  try {
    expect(await preparePromptEdit(transport, target, { userAgent: 'codex_cli_rs/0.155.1' })).toMatchObject({ beforeTurnId: 'turn-2', cwd: '/tmp' });
    expect(app.requests.every(r => r.method.startsWith('thread/') && ['thread/read', 'thread/turns/list'].includes(r.method))).toBe(true);
  } finally { await transport.dispose(); }
});
it('starts fresh for the first prompt, like Esc', async () => {
  const { transport } = fixture([{ id: 'turn-2', status: 'completed', items: [prompt] }]);
  try { expect(await preparePromptEdit(transport, target, { userAgent: 'codex_cli_rs/0.155.1' })).not.toHaveProperty('beforeTurnId'); }
  finally { await transport.dispose(); }
});
it.each([
  { id: 'turn-2', status: 'inProgress', items: [prompt] },
  { id: 'turn-2', status: 'completed', items: [{ ...prompt, id: 'first' }, prompt] },
  { id: 'turn-2', status: 'completed', items: [{ ...prompt, id: 'different' }] },
  { id: 'turn-2', status: 'completed', items: [{ type: 'enteredReviewMode' }, prompt, { type: 'exitedReviewMode' }] },
  { id: 'turn-2', status: 'completed', items: [{ ...prompt, content: [{ type: 'skill', name: 'test', path: '/tmp/test' }] }] },
])('rejects unsafe or unrepresentable prompt edits before dispatch', async turn => {
  const { transport } = fixture([turn]);
  try { await expect(preparePromptEdit(transport, target, { userAgent: 'codex_cli_rs/0.155.1' })).rejects.toThrow(); }
  finally { await transport.dispose(); }
});
it('does not guess Esc behavior for an unverified native version', async () => {
  const { app, transport } = fixture([]);
  try {
    await expect(preparePromptEdit(transport, target, { userAgent: 'codex_cli_rs/0.156.0' })).rejects.toThrow(/version/i);
    expect(app.requests).toHaveLength(0);
  } finally { await transport.dispose(); }
});

it('forks once over the native transport and returns a usable independent session', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    initialize: () => ({ userAgent: 'codex_cli_rs/0.155.1' }),
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp' } }),
    'thread/turns/list': params => (params as { threadId: string }).threadId === 'source'
      ? { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }, { id: 'turn-1', status: 'completed', items: [] }], nextCursor: null }
      : { data: [{ id: 'turn-1', status: 'completed', items: [] }], nextCursor: null },
    'thread/fork': () => ({ thread: { id: 'branch', cwd: '/tmp' }, model: 'model' }),
  });
  const session = await new CodexAppServerProvider({ spawn: () => app.child }).forkForPromptEdit(target);
  try {
    expect(await session.runtimeInfo()).toMatchObject({ sessionId: 'branch', cwd: '/tmp' });
    expect(app.requests.filter(r => r.method === 'thread/fork')).toEqual([expect.objectContaining({ params: expect.objectContaining({ threadId: 'source', beforeTurnId: 'turn-2', excludeTurns: true }) })]);
    expect(app.requests.some(r => ['thread/rollback', 'thread/revert', 'turn/start'].includes(r.method))).toBe(false);
  } finally { await session.dispose(); }
});

it('does not request persisted history for an unmaterialized first-prompt branch', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    initialize: () => ({ userAgent: 'codex-tui/0.155.1 (Mac OS; arm64)' }),
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp' } }),
    'thread/turns/list': params => {
      expect((params as { threadId: string }).threadId).toBe('source');
      return { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }], nextCursor: null };
    },
    'thread/start': () => ({ thread: { id: 'fresh', cwd: '/tmp' } }),
  });
  const session = await new CodexAppServerProvider({ spawn: () => app.child }).forkForPromptEdit(target);
  try {
    expect((await session.runtimeInfo()).sessionId).toBe('fresh');
    expect((await session.observe()[Symbol.asyncIterator]().next()).value).toMatchObject({ type: 'history_boundary' });
    expect(app.requests.some(request => ['thread/fork', 'turn/start'].includes(request.method))).toBe(false);
  } finally { await session.dispose(); }
});

it('allows persisted image placeholders that the web composer can restore', async () => {
  const content = [
    { type: 'text', text: '[image #1]', text_elements: [{ byteRange: { start: 0, end: 10 }, placeholder: '[image #1]' }] },
    { type: 'localImage', path: '/managed/image.png' },
  ];
  const { transport } = fixture([{ id: 'turn-2', status: 'completed', items: [{ ...prompt, content }] }]);
  try { await expect(preparePromptEdit(transport, target, { userAgent: 'codex_cli_rs/0.155.1' })).resolves.toMatchObject({ cwd: '/tmp' }); }
  finally { await transport.dispose(); }
});
it('still rejects other native text bindings during prompt editing', async () => {
  const content = [{ type: 'text', text: '$skill', text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: '$skill' }] }];
  const { transport } = fixture([{ id: 'turn-2', status: 'completed', items: [{ ...prompt, content }] }]);
  try { await expect(preparePromptEdit(transport, target, { userAgent: 'codex_cli_rs/0.155.1' })).rejects.toThrow(/bindings/); }
  finally { await transport.dispose(); }
});
