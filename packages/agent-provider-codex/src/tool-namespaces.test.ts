import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import type { AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const schema = { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false };
const namespace = (text: string, deferred = true): AgentSessionToolNamespace => ({ name: 'agent_remote', description: 'Agent Remote Control', deferred,
  tools: [{ name: 'call_for_support', description: 'Call for support.', inputSchema: schema, execute: async () => text }] });

async function harness(resume: boolean, namespaces: AgentSessionToolNamespace[]) {
  const native = createScriptedAppServer({
    'thread/start': () => ({ thread: { id: 'worker' } }),
    'thread/resume': () => ({ thread: { id: 'worker' } }),
    'thread/read': () => ({ thread: { id: 'worker', turns: [] } }),
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
