import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import type { AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const schema = { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false };
const namespace = (text: string, deferred = true): AgentSessionToolNamespace => ({ name: 'agent_remote', description: 'Agent Remote Control', deferred,
  tools: [{ name: 'call_for_support', description: 'Call for support.', inputSchema: schema, execute: async () => text }] });

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
/** A rollout whose first record is the thread's metadata, declaring these namespaces as dynamic tools. */
function rollout(declared: string[] | undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-')); directories.push(directory);
  const path = join(directory, 'rollout.jsonl');
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'worker', ...(declared ? { dynamic_tools: declared.map(name => ({ type: 'namespace', name, description: 'd', tools: [] })) } : {}) } })}\n{"type":"turn_context"}\n`);
  return path;
}

async function harness(resume: boolean, namespaces: AgentSessionToolNamespace[], options: { declared?: string[]; failFirstResume?: string } = { declared: ['agent_remote'] }) {
  const path = rollout(options.declared);
  let resumes = 0;
  const native = createScriptedAppServer({
    'thread/start': () => ({ thread: { id: 'worker' } }),
    'thread/resume': () => { if (resumes++ === 0 && options.failFirstResume) throw new Error(options.failFirstResume); return { thread: { id: 'worker' } }; },
    'thread/read': () => ({ thread: { id: 'worker', turns: [], path } }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => native.child });
  const session = resume
    ? await provider.resumeSession({ providerId: 'codex', sessionId: 'worker', opaque: '{}' }, { toolNamespaces: namespaces })
    : await provider.createSession({ sessionId: 'local', toolNamespaces: namespaces });
  const lines = createInterface({ input: native.child.stdin });
  let next = 0;
  const call = (params: Record<string, unknown>) => {
    const id = `call-${next++}`;
    const response = new Promise<any>(resolve => lines.on('line', line => { const value = JSON.parse(line); if (value.id === id) resolve(value.result); }));
    native.child.stdout.write(JSON.stringify({ id, method: 'item/tool/call', params: { threadId: 'worker', turnId: 'turn', callId: id, ...params } }) + '\n');
    return response;
  };
  return { native, session, call, close: async () => { lines.close(); await session.dispose(); } };
}

it('declares a deferred namespace at thread start and routes its calls', async () => {
  const h = await harness(false, [namespace('ACCEPTED')]);
  try {
    expect(h.native.requests.find(request => request.method === 'thread/start')?.params).toMatchObject({ dynamicTools: [{ type: 'namespace', name: 'agent_remote',
      description: 'Agent Remote Control', tools: [{ type: 'function', name: 'call_for_support', description: 'Call for support.', inputSchema: schema, deferLoading: true }] }] });
    expect(await h.call({ namespace: 'agent_remote', tool: 'call_for_support', arguments: { role: 'reviewer' } }))
      .toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'ACCEPTED' }] });
    expect(await h.call({ namespace: 'other', tool: 'call_for_support', arguments: { role: 'reviewer' } })).toMatchObject({ success: false });
    expect(await h.call({ tool: 'call_for_support', arguments: { role: 'reviewer' } })).toMatchObject({ success: false });
  } finally { await h.close(); }
});

it('declares a direct namespace without deferral', async () => {
  const h = await harness(false, [namespace('ACCEPTED', false)]);
  try {
    const declared = (h.native.requests.find(request => request.method === 'thread/start')?.params as { dynamicTools: Array<{ tools: object[] }> }).dynamicTools[0]!.tools[0];
    expect(declared).not.toHaveProperty('deferLoading');
  } finally { await h.close(); }
});

it('rebinds executors of declared namespaces and refuses new declarations', async () => {
  const h = await harness(true, [namespace('BEFORE')]);
  try {
    expect(h.native.requests.find(request => request.method === 'thread/resume')?.params).not.toHaveProperty('dynamicTools');
    expect(await h.call({ namespace: 'agent_remote', tool: 'call_for_support', arguments: { role: 'x' } })).toMatchObject({ contentItems: [{ text: 'BEFORE' }] });
    await h.session.updateToolNamespaces!([namespace('AFTER')]);
    expect(await h.call({ namespace: 'agent_remote', tool: 'call_for_support', arguments: { role: 'x' } })).toMatchObject({ contentItems: [{ text: 'AFTER' }] });
    await expect(h.session.updateToolNamespaces!([{ name: 'new_namespace', description: 'd', tools: [] }])).rejects.toThrow(/thread start/i);
    await expect(h.session.updateToolNamespaces!([namespace('AFTER', false)])).rejects.toThrow(/thread start/i);
  } finally { await h.close(); }
});

/** Calls the MCP server that thread/resume named for a namespace, as Codex would. */
async function mcp(config: Record<string, any>, name: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const server = config[`mcp_servers.${name}`];
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...server.http_headers, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
}
const resumeConfig = (h: Awaited<ReturnType<typeof harness>>) => (h.native.requests.filter(request => request.method === 'thread/resume').at(-1)!.params as { config: Record<string, any> }).config;

it('offers a namespace the thread did not declare at its start as an MCP server on resume, for this session only', async () => {
  const h = await harness(true, [namespace('BRIDGED')], { declared: [] });
  try {
    const config = resumeConfig(h);
    expect(config).toMatchObject({ 'features.default_mode_request_user_input': true, 'mcp_servers.agent_remote': { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/agent_remote$/),
      http_headers: { Authorization: expect.stringMatching(/^Bearer /) }, default_tools_approval_mode: 'approve' } });
    expect((await mcp(config, 'agent_remote', 'initialize', { protocolVersion: '2025-06-18' })).body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    expect((await mcp(config, 'agent_remote', 'tools/list')).body.result.tools).toEqual([{ name: 'call_for_support', description: 'Call for support.', inputSchema: schema }]);
    expect((await mcp(config, 'agent_remote', 'tools/call', { name: 'call_for_support', arguments: { role: 'reviewer' } })).body.result).toEqual({ content: [{ type: 'text', text: 'BRIDGED' }] });
    // Executors rebind as for declared namespaces.
    await h.session.updateToolNamespaces!([namespace('REBOUND')]);
    expect((await mcp(config, 'agent_remote', 'tools/call', { name: 'call_for_support', arguments: { role: 'x' } })).body.result.content[0].text).toBe('REBOUND');
    // Only loopback requests without a web page's Origin, with this session's token, reach the tools.
    expect((await mcp(config, 'agent_remote', 'tools/list', {}, { Authorization: 'Bearer wrong-token-of-sufficient-length' })).status).toBe(401);
    expect((await mcp(config, 'agent_remote', 'tools/list', {}, { Origin: 'https://example.com' })).status).toBe(403);
  } finally { await h.close(); }
  expect((await mcp(resumeConfig(h), 'agent_remote', 'tools/list')).status).toBe(401);
});

it('offers no MCP server for a namespace the thread declared at its start', async () => {
  const h = await harness(true, [namespace('DECLARED')], { declared: ['agent_remote'] });
  try { expect(Object.keys(resumeConfig(h))).toEqual(['features.default_mode_request_user_input']); } finally { await h.close(); }
});

it('opens the session without the MCP server when the user\'s Codex config already has one of that name', async () => {
  const h = await harness(true, [namespace('X')], { declared: [], failFirstResume: 'failed to load configuration: url is not supported for stdio\nin `mcp_servers.agent_remote`' });
  try {
    expect(h.native.requests.filter(request => request.method === 'thread/resume')).toHaveLength(2);
    expect(Object.keys(resumeConfig(h))).toEqual(['features.default_mode_request_user_input']);
  } finally { await h.close(); }
});
