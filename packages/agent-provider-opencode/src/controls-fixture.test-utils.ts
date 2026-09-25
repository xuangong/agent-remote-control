import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeTransport } from './transport.js';

export async function controlsFixture(restricted = false) {
  const requests: Array<{ method: string; path: string; directory: string | null; body: any }> = [];
  const state = {
    rejectUpdate: false,
    rejectSwitch: false,
    permission: [{ permission: 'bash', pattern: 'git *', action: 'ask' }] as any[],
    providers: { all: [{ id: 'test', name: 'Test', models: { main: { id: 'main', name: 'Main', limit: { context: 128000, output: 8192 }, variants: { fast: {}, deep: {} } }, other: { id: 'other', name: 'Other' } } }, { id: 'offline', name: 'Offline', models: { missing: { id: 'missing', name: 'Unavailable' } } }], connected: ['test'], default: { test: 'main' } },
    agents: [{ name: 'build', mode: 'primary', permission: [{ permission: '*', pattern: '*', action: 'allow' }, { permission: 'bash', pattern: '*', action: 'ask' }] }, { name: 'plan', mode: 'primary', permission: [{ permission: 'edit', pattern: '*', action: 'deny' }] }, { name: 'hidden', hidden: true, mode: 'primary', permission: [] }, { name: 'worker', mode: 'subagent', permission: [] }] as any[],
    commands: [{ name: 'check', description: 'Check project', source: 'command', template: 'Check $ARGUMENTS', hints: ['$ARGUMENTS'] }, { name: 'design', description: 'Design skill', source: 'skill', template: '# Design\nNative instructions\nBase directory for this skill: /project/.opencode/skills/design', hints: [] }, { name: 'mcp-prompt', source: 'mcp', template: 'Native MCP prompt', hints: ['$1'] }] as any[],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method!, path: url.pathname, directory: url.searchParams.get('directory'), body });
    const json = (data: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (url.pathname === '/provider') return json(state.providers);
    if (url.pathname === '/agent') return json(state.agents);
    if (url.pathname === '/command') return json(state.commands);
    if (url.pathname === '/session/ses_controls') {
      if (request.method === 'PATCH') {
        if (state.rejectUpdate) { response.writeHead(500); response.end(); return; }
        state.permission.push(...body.permission);
      }
      return json({ id: 'ses_controls', permission: state.permission });
    }
    if (url.pathname === '/session/ses_controls/summarize') return json(true);
    if (url.pathname === '/session/ses_controls/command') return json({ info: {}, parts: [] });
    if (url.pathname.startsWith('/api/session/')) {
      if (state.rejectSwitch) { response.writeHead(409); response.end(); return; }
      response.writeHead(204); response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test HTTP port.');
  const transport = new OpenCodeTransport({ serverUrl: `http://127.0.0.1:${address.port}`, restrictedNative: restricted, requestTimeoutMs: 1000 });
  return { transport, state, requests, async close() { await transport.close(); const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } };
}
