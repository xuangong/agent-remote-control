import { realpathSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentSessionTool, AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';

const cwd = realpathSync(process.cwd());
const schema = { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false };
const hostTool = (name: string, text = name, description = `Run ${name}.`): AgentSessionTool => ({ name, description, inputSchema: schema, execute: async () => text });
const namespace = (tools: AgentSessionTool[], name = 'agent_remote'): AgentSessionToolNamespace => ({ name, description: 'Agent Remote Control', tools });

function fixture(native: { setMcpServers?: boolean; errors?: Record<string, string> } = {}) {
  const captured: Options[] = [];
  const applied: Array<Record<string, McpServerConfig>> = [];
  const flags: unknown[] = [];
  const catalog = { list: async () => [], info: async () => ({ cwd }) as any, messages: async () => [], children: async () => [] };
  const provider = new ClaudeAgentProvider({ catalog, query: ({ options }) => {
    captured.push(options);
    const stream = new Channel<any>();
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), initializationResult: async () => ({}),
      close: () => stream.close(), interrupt: async () => {}, setPermissionMode: async () => {},
      applyFlagSettings: async (settings: unknown) => { flags.push(settings); },
      ...(native.setMcpServers === false ? {} : { setMcpServers: async (servers: Record<string, McpServerConfig>) => {
        applied.push(servers);
        return { added: Object.keys(servers), removed: [], errors: native.errors ?? {} };
      } }) } as any;
  } });
  return { captured, applied, flags, provider };
}

async function call(server: McpServerConfig, name: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'namespace-test', version: '1.0.0' });
  const instance = (server as { instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> } }).instance;
  await instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    const result = await client.callTool({ name, arguments: { role: 'reviewer' } });
    return { tools, result };
  } finally { await client.close(); }
}

it('declares the live namespace capability', () => {
  expect(fixture().provider.descriptor.sessionExtensions).toEqual({ instructions: true, tools: true, toolNamespaces: 'live' });
});

it('opens namespaces as their own servers and allows their tools without asking', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'local', cwd, toolNamespaces: [namespace([hostTool('call_for_support', 'ACCEPTED')])] });
  try {
    const options = f.captured[0]!;
    expect(Object.keys(options.mcpServers!)).toEqual(['agent_remote']);
    expect(options.settings).toEqual({ permissions: { allow: ['mcp__agent_remote'] } });
    expect(await call(options.mcpServers!.agent_remote!, 'call_for_support')).toMatchObject({ tools: ['call_for_support'], result: { content: [{ type: 'text', text: 'ACCEPTED' }] } });
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque)).not.toHaveProperty('toolNamespaces');
  } finally { await f.provider.dispose(); }
}, 10000);

it('adds, rebinds, replaces and removes namespace servers on the running query, keeping the host server', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'local', cwd, tools: [hostTool('read_team')] });
  try {
    expect(f.captured[0]!.settings).toBeUndefined();
    const host = f.captured[0]!.mcpServers!.agent_host;
    await session.updateToolNamespaces!([namespace([hostTool('call_for_support', 'FIRST')])]);
    expect(Object.keys(f.applied.at(-1)!).sort()).toEqual(['agent_host', 'agent_remote']);
    expect(f.applied.at(-1)!.agent_host).toBe(host);
    expect(f.flags.at(-1)).toEqual({ permissions: { allow: ['mcp__agent_remote'] } });
    const first = f.applied.at(-1)!.agent_remote!;
    const calls = f.applied.length;

    // The same declaration keeps its connected server and runs the new executor.
    await session.updateToolNamespaces!([namespace([hostTool('call_for_support', 'REBOUND')])]);
    expect(f.applied.length).toBe(calls + 1);
    expect(f.applied.at(-1)!.agent_remote).toBe(first);
    expect(await call(first, 'call_for_support')).toMatchObject({ result: { content: [{ type: 'text', text: 'REBOUND' }] } });

    // A changed declaration is removed before its new server is added, because Claude keeps servers by name.
    await session.updateToolNamespaces!([namespace([hostTool('call_for_support', 'CHANGED', 'Call for support differently.')])]);
    expect(Object.keys(f.applied.at(-2)!)).toEqual(['agent_host']);
    expect(Object.keys(f.applied.at(-1)!).sort()).toEqual(['agent_host', 'agent_remote']);
    expect(f.applied.at(-1)!.agent_remote).not.toBe(first);

    await session.updateToolNamespaces!([]);
    expect(Object.keys(f.applied.at(-1)!)).toEqual(['agent_host']);
    expect(f.flags.at(-1)).toEqual({ permissions: { allow: [] } });
  } finally { await f.provider.dispose(); }
}, 10000);

it('allows Host tools in a read-only session, which cannot ask', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'local', cwd, access: 'read_only', tools: [hostTool('report')] });
  try {
    expect(f.captured[0]!.settings).toMatchObject({ permissions: { allow: ['mcp__agent_host'] } });
    await session.updateToolNamespaces!([namespace([hostTool('call_for_support')])]);
    expect(f.flags.at(-1)).toEqual({ permissions: { allow: ['mcp__agent_host', 'mcp__agent_remote'] } });
  } finally { await f.provider.dispose(); }
}, 10000);

it('refuses reserved names and runtimes that cannot change servers, and reports servers that failed to connect', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'local', cwd });
  await expect(session.updateToolNamespaces!([namespace([hostTool('x')], 'agent_host')])).rejects.toThrow();
  const old = fixture({ setMcpServers: false });
  const oldSession = await old.provider.createSession({ sessionId: 'local', cwd });
  await expect(oldSession.updateToolNamespaces!([namespace([hostTool('x')])])).rejects.toThrow(/update Claude Code/i);
  const failing = fixture({ errors: { agent_remote: 'refused' } });
  const failingSession = await failing.provider.createSession({ sessionId: 'local', cwd });
  await expect(failingSession.updateToolNamespaces!([namespace([hostTool('x')])])).rejects.toThrow(/agent_remote: refused/);
  expect(failing.flags.at(-1)).toEqual({ permissions: { allow: [] } });
  // A later update still runs after a failed one.
  await expect(session.updateToolNamespaces!([namespace([hostTool('x')])])).resolves.toBeUndefined();
  await Promise.all([f.provider.dispose(), old.provider.dispose(), failing.provider.dispose()]);
}, 10000);

it('closes namespace servers when the session closes', async () => {
  const f = fixture();
  const session = await f.provider.createSession({ sessionId: 'local', cwd, toolNamespaces: [namespace([hostTool('call_for_support')])] });
  const close = vi.spyOn((f.captured[0]!.mcpServers!.agent_remote as { instance: { close(): Promise<void> } }).instance, 'close');
  await session.dispose();
  expect(close).toHaveBeenCalled();
  await f.provider.dispose();
}, 10000);
