import { expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';

function fixture() {
  const captured: Options[] = [];
  const catalog = { list: async () => [], info: async () => ({ cwd: process.cwd() }) as any, messages: async () => [], children: async () => [] };
  const provider = () => new ClaudeAgentProvider({ catalog, query: ({ options }) => {
    captured.push(options);
    const stream = new Channel<any>();
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), initializationResult: async () => ({}),
      close: () => stream.close(), interrupt: async () => {}, setPermissionMode: async () => {} } as any;
  } });
  return { captured, provider };
}
const tool = (execute = vi.fn(async () => 'source evidence')) => ({ name: 'read_main_session', description: 'Read the bound main session',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, required: ['limit'], additionalProperties: false }, execute });

it('appends role instructions to the native Claude preset and restores them in a new adapter', async () => {
  const f = fixture(); const first = f.provider();
  const session = await first.createSession({ sessionId: 'local', instructions: 'Coordinate this work.' });
  const handle = (await session.runtimeInfo()).persistence!;
  expect(f.captured[0]?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Coordinate this work.' });
  await first.dispose();
  const cold = f.provider(); const resumed = await cold.resumeSession(handle, { instructions: 'Review the accepted scope.' });
  try { expect(f.captured[1]).toMatchObject({ resume: handle.sessionId, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Review the accepted scope.' } }); }
  finally { await resumed.dispose(); await cold.dispose(); }
}, 10000);

it('preserves custom string system prompts while appending explicit instructions', async () => {
  const f = fixture(); const provider = f.provider();
  const first = await provider.createSession({ sessionId: 'local', systemPrompt: 'Custom base' });
  expect(f.captured[0]?.systemPrompt).toBe('Custom base'); await first.dispose();
  const second = await provider.createSession({ sessionId: 'local', systemPrompt: 'Custom base', instructions: 'Role' });
  try { expect(f.captured[1]?.systemPrompt).toBe('Custom base\n\nRole'); } finally { await provider.dispose(); }
}, 10000);

it('exposes JSON-schema Host tools through real in-process MCP after create and cold resume', async () => {
  const f = fixture(); const execute = vi.fn(async () => 'source evidence');
  const initial = f.provider(); let session = await initial.createSession({ sessionId: 'local', tools: [tool(execute)] });
  const handle = (await session.runtimeInfo()).persistence!;
  expect(JSON.parse(handle.opaque).tools).toBeUndefined();
  for (const resume of [false, true]) {
    let cold: ClaudeAgentProvider | undefined;
    if (resume) { cold = f.provider(); session = await cold.resumeSession(handle, { tools: [tool(execute)] }); }
    const server = f.captured.at(-1)!.mcpServers?.agent_host as any;
    expect(server?.type).toBe('sdk');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'adapter-test', version: '1.0.0' });
    const close = vi.spyOn(server.instance, 'close');
    await server.instance.connect(serverTransport); await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([expect.objectContaining({ name: 'read_main_session', inputSchema: tool().inputSchema })]);
      expect(await client.callTool({ name: 'read_main_session', arguments: { limit: 2 } })).toMatchObject({ content: [{ type: 'text', text: 'source evidence' }] });
      expect(await client.callTool({ name: 'read_main_session', arguments: { limit: 'bad' } })).toMatchObject({ isError: true });
      expect(execute).toHaveBeenCalledTimes(resume ? 3 : 1);
      execute.mockRejectedValueOnce(new Error('Evidence unavailable'));
      expect(await client.callTool({ name: 'read_main_session', arguments: { limit: 2 } })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Evidence unavailable' }] });
    } finally { await session.dispose(); expect(close).toHaveBeenCalled(); await client.close(); await cold?.dispose(); }
  }
  await initial.dispose();
}, 10000);

it('rejects invalid extension schemas before creating a native Claude query', async () => {
  const f = fixture(); const provider = f.provider();
  await expect(provider.createSession({ sessionId: 'local', tools: [{ ...tool(), inputSchema: { type: 'invalid' } }] })).rejects.toThrow(/schema/i);
  expect(f.captured).toEqual([]); await provider.dispose();
}, 10000);
