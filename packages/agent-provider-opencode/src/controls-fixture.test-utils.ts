import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AgentInfo, CommandInfo, ModelInfo, PermissionRuleset, SessionInfo, SkillInfo } from '@opencode/client';
import { OpenCodeTransport } from './transport.js';

const model = (id: string, enabled = true): ModelInfo => ({
  providerID: enabled ? 'test' : 'offline', id, modelID: id, name: id === 'main' ? 'Main' : id,
  enabled, status: 'active', capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: id === 'main' ? [{ id: 'fast' }, { id: 'deep' }] : [],
  limit: { context: id === 'main' ? 128000 : 0, output: 8192 }, cost: [], time: { released: 1 },
});
const agent = (name: string, permissions: PermissionRuleset, options: Partial<AgentInfo> = {}): AgentInfo => ({
  id: name, name, mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions, ...options,
});

export async function controlsFixture(restricted = false) {
  const requests: Array<{ method: string; path: string; directory: string | null; body: any }> = [];
  const state = {
    rejectUpdate: false, ignoreUpdate: false, rejectSwitch: false, ignoreSwitch: false, explicitDefaultVariant: false,
    rejectModelList: false, modelReadGate: undefined as Promise<void> | undefined,
    selection: {} as { agent?: string; model?: { providerID: string; id: string; variant?: string } },
    permission: [{ action: 'bash', resource: 'git *', effect: 'ask' }] as PermissionRuleset,
    models: [model('main'), model('other'), model('missing', false)],
    agents: [agent('build', [{ action: '*', resource: '*', effect: 'allow' }, { action: 'bash', resource: '*', effect: 'ask' }]), agent('plan', [{ action: 'edit', resource: '*', effect: 'deny' }]), agent('hidden', [], { hidden: true }), agent('worker', [], { mode: 'subagent' })],
    commands: [{ name: 'check', description: 'Check project' }, { name: 'mcp-prompt' }] as CommandInfo[],
    skills: [{ id: 'skill_design', name: 'design', description: 'Design skill', path: '/project/.opencode/skills/design/SKILL.md', content: '# Design\nNative instructions' }] as SkillInfo[],
  };
  const native = (): SessionInfo => ({ id: 'ses_controls', projectID: 'project', title: 'Controls', location: { directory: '/project' },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, permissions: state.permission, ...state.selection });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method!, path: url.pathname, directory: url.searchParams.get('location[directory]'), body });
    const json = (data: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    const done = () => { response.writeHead(204); response.end(); };
    const failure = (status: number) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ _tag: 'UnknownError', message: `Native HTTP ${status}` })); };
    const catalog = (data: unknown) => json({ location: { directory: '/project' }, data });
    if (url.pathname === '/api/model') { await state.modelReadGate; return state.rejectModelList ? failure(500) : catalog(state.models); }
    if (url.pathname === '/api/agent') return catalog(state.agents);
    if (url.pathname === '/api/command') return catalog(state.commands);
    if (url.pathname === '/api/skill') return catalog(state.skills);
    if (url.pathname === '/api/session/ses_controls') {
      if (request.method === 'PATCH') {
        if (state.rejectUpdate) return failure(500);
        if (!state.ignoreUpdate) state.permission = body.permissions;
        return done();
      }
      return json({ data: native() });
    }
    if (url.pathname === '/api/session/ses_controls/compact') return json({ data: { id: body.id, sessionID: 'ses_controls', type: 'compaction', time: { created: 1 }, payload: {}, delivery: 'queue' } });
    if (url.pathname === '/api/session/ses_controls/command') return done();
    if (url.pathname === '/api/session/ses_controls/prompt') return json({ data: { id: body.id, sessionID: 'ses_controls', type: 'user', time: { created: 1 }, payload: { text: body.text, skills: body.skills }, delivery: 'queue' } });
    if (url.pathname === '/api/session/ses_controls/agent' || url.pathname === '/api/session/ses_controls/model') {
      if (state.rejectSwitch) return failure(409);
      if (!state.ignoreSwitch) {
        Object.assign(state.selection, body);
        if (state.explicitDefaultVariant && body.model && !body.model.variant) state.selection.model!.variant = 'default';
      }
      return done();
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test HTTP port.');
  const transport = new OpenCodeTransport({ serverUrl: `http://127.0.0.1:${address.port}`, restrictedNative: restricted, requestTimeoutMs: 1000 });
  return { transport, state, requests, async close() { await transport.close(); const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } };
}
