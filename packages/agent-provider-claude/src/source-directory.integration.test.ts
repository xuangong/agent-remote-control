import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Options, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { createClaudeSessionDirectory } from '../../agent-host/src/claude-directory.js';
import { SessionReferenceStore } from '../../agent-host/src/session-reference.js';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';

const userTool: AgentSessionTool = { name: 'user_tool', description: 'Read user context', inputSchema: { type: 'object' }, execute: async () => 'User context' };
const tpmTool: AgentSessionTool = { name: 'read_work_record', description: 'Read the current work record', inputSchema: { type: 'object' }, execute: async () => 'Current work record' };

it.each([undefined, 'Custom base', ''])('restores the Claude source tool through real MCP with base prompt %j', async systemPrompt => {
  const root = await mkdtemp(join(tmpdir(), 'arc-claude-source-mcp-'));
  const source = randomUUID(), nextSource = randomUUID();
  const reads: string[] = [], captures: Options[] = [], clients: Client[] = [], startupResults: unknown[] = [];
  const catalog = { list: async () => [], info: async (sessionId: string) => ({ sessionId, cwd: root }) as SDKSessionInfo,
    messages: async () => [], children: async () => [], history: async (id: string) => {
      reads.push(id); return { entries: [{ id: 'native-message', turnId: '', role: 'user' as const, text: `History ${id}`, textOffset: 0, totalChars: 44 }] };
    } };
  const provider = () => new ClaudeAgentProvider({ catalog, query: ({ options }) => {
    captures.push(options); const stream = new Channel<any>();
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), close: () => stream.close(), interrupt: async () => {}, setPermissionMode: async () => {},
      initializationResult: async () => {
        const server = options.mcpServers!.agent_host as any;
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'directory-source-test', version: '1.0.0' }); clients.push(client);
        await server.instance.connect(serverTransport); await client.connect(clientTransport);
        startupResults.push(await client.callTool({ name: 'read_source_session', arguments: {} }));
        return {};
      } } as any;
  } });
  const store = new SessionReferenceStore(join(root, 'references'), 'claude');
  let directory = createClaudeSessionDirectory(provider(), [], undefined, store);
  try {
    const id = await directory.create({ cwd: root, sourceNativeSessionId: source, instructions: 'User instructions', tools: [userTool],
      ...(systemPrompt !== undefined ? { systemPrompt } : {}) });
    expect(startupResults[0]).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/identity.*ready/i) }] });
    expect(reads).toEqual([]);
    const assertPrompt = (value: Options) => {
      if (systemPrompt === undefined) expect(value.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code', append: expect.stringContaining('User instructions') });
      else { expect(typeof value.systemPrompt).toBe('string'); if (systemPrompt) expect(value.systemPrompt).toContain(systemPrompt); }
      expect(JSON.stringify(value.systemPrompt)).toContain('quoted background');
    };
    assertPrompt(captures[0]!);
    const first = clients[0]!;
    expect((await first.listTools()).tools.map(tool => tool.name)).toEqual(['user_tool', 'read_source_session']);
    expect(await first.callTool({ name: 'user_tool', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'User context' }] });
    const read = async (client: Client) => {
      const result = await client.callTool({ name: 'read_source_session', arguments: { limit: 1 } });
      expect(result.isError).not.toBe(true); return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    expect(await read(first)).toMatchObject({ sourceSessionId: source });
    directory.setSourceBindingReader!(async (reader, original, query, history) => {
      expect(reader).toBe(id); expect(original).toBe(source);
      return { ...await history(nextSource, query), sourceSessionId: nextSource, sourceRoleRevision: 2 };
    });
    expect(await read(first)).toMatchObject({ sourceSessionId: nextSource, sourceRoleRevision: 2 });
    directory.setSourceBindingReader!(async () => { throw new Error('Pending relationship'); });
    expect(await first.callTool({ name: 'read_source_session', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Pending relationship' }] });
    expect(reads).toEqual([source, nextSource]);
    await directory.close(); await first.close();
    directory = createClaudeSessionDirectory(provider(), [], undefined, new SessionReferenceStore(join(root, 'references'), 'claude'));
    await directory.open(id, { extensions: { instructions: 'TPM instructions', tools: [userTool, tpmTool] } });
    expect(startupResults[1]).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/identity.*ready/i) }] });
    assertPrompt(captures[1]!); expect(JSON.stringify(captures[1]!.systemPrompt)).toContain('TPM instructions');
    expect(captures[1]!.resume).toBe(id); expect(captures[1]!.model).toBeUndefined();
    const cold = clients[1]!;
    expect((await cold.listTools()).tools.map(tool => tool.name)).toEqual(['user_tool', 'read_work_record', 'read_source_session']);
    expect(await cold.callTool({ name: 'read_work_record', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'Current work record' }] });
    expect(await read(cold)).toMatchObject({ sourceSessionId: source });
  } finally { await directory.close(); await Promise.all(clients.map(client => client.close())); await rm(root, { recursive: true, force: true }); }
}, 10000);

for (const routed of [false, true]) {
  it.each(['dispose', 'revoke', 'close'] as const)(`withholds held ${routed ? 'routed' : 'local'} source content through MCP after %s`, async change => {
    const root = await mkdtemp(join(tmpdir(), 'arc-claude-held-mcp-')); const source = randomUUID(), nextSource = randomUUID();
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let captured!: Options, allowed = true; const reads: string[] = [];
    const provider = new ClaudeAgentProvider({ catalog: { list: async () => [], info: async () => undefined, messages: async () => [],
      history: async id => { reads.push(id); enter(); await gate; return { entries: [{ id: 'protected', turnId: '', role: 'user', text: 'Protected context', textOffset: 0, totalChars: 17 }] }; } },
      query: ({ options }) => {
        captured = options; const stream = new Channel<any>();
        return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), initializationResult: async () => ({}),
          close: () => stream.close(), interrupt: async () => {}, setPermissionMode: async () => {} } as any;
      } });
    const directory = createClaudeSessionDirectory(provider, [], undefined, new SessionReferenceStore(join(root, 'references'), 'claude'));
    const client = new Client({ name: 'held-source-test', version: '1.0.0' });
    directory.setSourceAccessCheck!(async () => { if (!allowed) throw new Error('Current source access revoked'); });
    if (routed) directory.setSourceBindingReader!(async (_reader, _source, query, read) => ({ ...await read(nextSource, query), sourceSessionId: nextSource }));
    try {
      const id = await directory.create({ cwd: root, sourceNativeSessionId: source });
      const server = captured.mcpServers!.agent_host as any;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport); await client.connect(clientTransport);
      const pending = client.callTool({ name: 'read_source_session', arguments: {} });
      const result = change === 'revoke'
        ? expect(pending).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/revoked/i) }] })
        : expect(pending).rejects.toThrow(/connection closed/i);
      await entered;
      if (change === 'dispose') await (await directory.open(id)).dispose();
      else if (change === 'revoke') allowed = false;
      else await directory.close();
      finish(); await result; expect(reads).toEqual([routed ? nextSource : source]);
    } finally { finish(); await directory.close(); await client.close(); await rm(root, { recursive: true, force: true }); }
  }, 10000);
}
