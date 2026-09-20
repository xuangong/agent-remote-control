import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

it('registers a real native tool and answers tool requests after create and resume', async () => {
  for (const resume of [false, true]) {
    const native = createScriptedAppServer({
      'thread/start': () => ({ thread: { id: 'side' } }),
      'thread/resume': () => ({ thread: { id: 'side' } }),
      'thread/read': () => ({ thread: { id: 'side', turns: [] } }),
    });
    const provider = new CodexAppServerProvider({ spawn: () => native.child });
    const tools = [{ name: 'read_source_session', description: 'Read source', inputSchema: { type: 'object' },
      execute: async (args: unknown) => JSON.stringify({ source: 'parent', args }) }];
    const session = resume
      ? await provider.resumeSession({ providerId: 'codex', sessionId: 'side', opaque: '{}' }, { tools, systemPrompt: 'Read source on demand.' })
      : await provider.createSession({ sessionId: 'local', tools, systemPrompt: 'Read source on demand.' });
    const lines = createInterface({ input: native.child.stdin });
    try {
      const opening = native.requests.find(request => request.method === (resume ? 'thread/resume' : 'thread/start'))!;
      expect(opening.params).toMatchObject({ developerInstructions: 'Read source on demand.',
        ...(!resume ? { dynamicTools: [{ type: 'function', name: 'read_source_session', description: 'Read source', inputSchema: { type: 'object' } }] } : {}) });
      const response = new Promise<any>(resolve => lines.on('line', line => { const value = JSON.parse(line); if (value.id === 'tool-1') resolve(value); }));
      native.child.stdout.write(JSON.stringify({ id: 'tool-1', method: 'item/tool/call', params: {
        threadId: 'side', turnId: 'turn', callId: 'call', tool: 'read_source_session', arguments: { limit: 2 },
      } }) + '\n');
      expect((await response).result).toEqual({ success: true, contentItems: [{ type: 'inputText', text: '{"source":"parent","args":{"limit":2}}' }] });
    } finally { lines.close(); await session.dispose(); }
  }
});

it('reads bounded native pages without resuming or hydrating the source', async () => {
  const native = createScriptedAppServer({
    'thread/items/list': () => ({ data: [{ turnId: 't', item: { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'x'.repeat(9000) }] } }], nextCursor: 'older' }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => native.child });
  const page = await provider.readSessionHistory('parent', { limit: 2, textOffset: 6000 });
  expect(page.entries[0]).toMatchObject({ id: 'u', turnId: 't', role: 'user', text: 'x'.repeat(3000), totalChars: 9000, textOffset: 6000 });
  expect(page.nextCursor).toBe('older');
  expect(native.requests.map(request => request.method)).toEqual(['initialize', 'thread/items/list']);
  expect(native.requests.at(-1)?.params).toEqual({ threadId: 'parent', limit: 2, sortDirection: 'desc' });
});

it('searches source messages with native cursors and exposes matching turns for follow-up reads', async () => {
  const native = createScriptedAppServer({ 'thread/searchOccurrences': () => ({ data: [{ itemId: 'a', turnId: 'decision', snippet: 'Use SQLite' }], nextCursor: 'next-hit' }) });
  const provider = new CodexAppServerProvider({ spawn: () => native.child });
  expect(await provider.readSessionHistory('parent', { query: 'sqlite', cursor: 'hit', limit: 1 })).toEqual({ entries: [{ id: 'a', turnId: 'decision', role: 'match', text: 'Use SQLite', totalChars: 10, textOffset: 0 }], nextCursor: 'next-hit' });
  expect(native.requests.at(-1)?.params).toEqual({ threadId: 'parent', searchTerm: 'sqlite', cursor: 'hit', limit: 1 });
});

it('reads source workspace metadata without catalog lookup or loading turns', async () => {
  const native = createScriptedAppServer({ 'thread/read': () => ({ thread: { id: 'child', cwd: '/workspace' } }) });
  const provider = new CodexAppServerProvider({ spawn: () => native.child });
  expect(await provider.readSessionWorkspace('child')).toBe('/workspace');
  expect(native.requests.map(request => request.method)).toEqual(['initialize', 'thread/read']);
  expect(native.requests.at(-1)?.params).toEqual({ threadId: 'child', includeTurns: false });
});

it('rejects workspace metadata for a different source', async () => {
  const native = createScriptedAppServer({ 'thread/read': () => ({ thread: { id: 'other', cwd: '/workspace' } }) });
  const provider = new CodexAppServerProvider({ spawn: () => native.child });
  await expect(provider.readSessionWorkspace('child')).rejects.toThrow('Source session metadata is unavailable.');
});
