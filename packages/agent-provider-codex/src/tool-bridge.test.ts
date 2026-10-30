import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexToolBridge, declaredToolNamespaces } from './tool-bridge.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const file = (text: string) => { const directory = mkdtempSync(join(tmpdir(), 'codex-bridge-')); directories.push(directory); const path = join(directory, 'rollout.jsonl'); writeFileSync(path, text); return path; };

it('reads the namespaces a thread declared from the first record of its rollout', async () => {
  const meta = (payload: object) => `${JSON.stringify({ type: 'session_meta', payload })}\n{"type":"event_msg"}\n`;
  expect(await declaredToolNamespaces(file(meta({ id: 't', dynamic_tools: [{ type: 'function', name: 'read_team' }, { type: 'namespace', name: 'agent_remote', tools: [] }] })), 't')).toEqual(new Set(['agent_remote']));
  expect(await declaredToolNamespaces(file(meta({ id: 't' })), 't')).toEqual(new Set());
  expect(await declaredToolNamespaces(file(meta({ id: 'other' })), 't')).toBeUndefined();
  expect(await declaredToolNamespaces(file('not json\n'), 't')).toBeUndefined();
  expect(await declaredToolNamespaces(join(tmpdir(), 'missing-rollout.jsonl'), 't')).toBeUndefined();
});

it('answers MCP requests on loopback, notifications without a body, and refuses other methods and unknown tools', async () => {
  const bridge = new CodexToolBridge();
  const registration = await bridge.register(['agent_remote'], () => [{ name: 'agent_remote', description: 'Agent Remote Control', tools: [
    { name: 'fails', description: 'd', inputSchema: { type: 'object' }, execute: async () => { throw new Error('Not enabled.'); } }] }]);
  const server = registration.config['mcp_servers.agent_remote'] as { url: string; http_headers: Record<string, string> };
  const post = (body: unknown) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...server.http_headers }, body: JSON.stringify(body) });
  try {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json()).toMatchObject({ result: { protocolVersion: '2025-06-18', instructions: 'Agent Remote Control' } });
    expect(await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fails' } })).json()).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Not enabled.' }], isError: true } });
    expect(await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing' } })).json()).toMatchObject({ error: { code: -32602 } });
    expect(await (await post({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).json()).toMatchObject({ error: { code: -32601 } });
    expect((await fetch(server.url, { headers: server.http_headers })).status).toBe(405);
    expect((await fetch(server.url.replace('agent_remote', 'other'), { method: 'POST', headers: server.http_headers, body: '{}' })).status).toBe(401);
    await expect(bridge.register(['bad.name'], () => [])).rejects.toThrow('invalid');
  } finally { registration.release(); await bridge.dispose(); }
});
