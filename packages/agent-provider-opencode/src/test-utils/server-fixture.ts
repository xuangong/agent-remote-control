import { createServer, type ServerResponse } from 'node:http';
import type { SessionInfo, SessionMessageInfo, PermissionRequest, FormInfo } from '@opencode/client';

import { OpenCodeAgentProvider } from '../provider.js';

export const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 0 } };
export const native = (id: string): SessionInfo => ({ id, title: 'Native session', projectID: 'project', location: { directory: process.cwd() },
  model: { providerID: 'test', id: 'model' }, agent: 'build', cost: 0, tokens, time: { created: 1, updated: 1 }, permissions: [] });
/**
 * An OpenCode server in this process, for tests: a v2 HTTP API over in-memory sessions, messages, permissions and forms, an event stream the
 * test writes to (`event`), and an OpenCode provider connected to it. `close` stops both.
 */
export async function openCodeServer(options: { onDiagnostic?: (line: string) => void } = {}) {
  const sessions = new Map<string, SessionInfo>([['ses_existing', native('ses_existing')]]);
  const messages = new Map<string, SessionMessageInfo[]>([['ses_existing', [{ type: 'user', id: 'msg_old', text: 'Existing prompt', time: { created: 1 } },
    { type: 'assistant', id: 'msg_reply', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [{ type: 'text', text: 'Existing answer' }], time: { created: 2, completed: 3 } },
    { type: 'idle', id: 'msg_idle', time: { created: 4 }, outcome: 'succeeded' }]]]);
  const streams = new Set<ServerResponse>(), requests: Array<{ path: string; method: string; query: URLSearchParams; body: any }> = [];
  const permissions = new Map<string, PermissionRequest[]>(), forms = new Map<string, FormInfo[]>();
  const instructions = new Map<string, Array<{key: string; value: unknown}>>();
  const state = { prompt: 'normal', historyFailures: 0, nativeFailures: 0, replyFailures: 0, version: '2.0.25', modelEnabled: true };
  const intercept = new Map<string, () => Promise<void>>();
  const block = (path: string) => {
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    intercept.set(path, async () => { arrive(); await gate; }); return { arrived, release };
  };
  let eventId = 0;
  const active: Record<string, { type: 'running' }> = {};
  const event = (type: string, data: unknown, id = `event_${++eventId}`) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ id, type, created: Date.now(), data })}\n\n`); };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://test'); let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: url.pathname, method: request.method!, query: url.searchParams, body });
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"type":"server.connected","data":{}}\n\n');
      streams.add(response); response.on('close', () => streams.delete(response)); return;
    }
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (url.pathname === '/api/info') return json({ version: state.version, pid: 1, urls: [], paths: {} });
    if (url.pathname === '/api/session/active') return json({ data: active });
    if (url.pathname === '/api/form') return json({ location: { directory: process.cwd() }, data: [...forms.values()].flat() });
    if (url.pathname === '/api/permission/request') return json({ location: { directory: process.cwd() }, data: [...permissions.values()].flat() });
    if (url.pathname === '/api/model') return json({ location: { directory: process.cwd() }, data: [{ providerID: 'test', id: 'model', modelID: 'model', name: 'Model', enabled: state.modelEnabled, status: 'active', capabilities: {}, variants: [], limit: { context: 1000, output: 100 } }] });
    if (url.pathname === '/api/agent') return json({ location: { directory: process.cwd() }, data: ['build', 'plan'].map(name => ({ id: name, name, mode: 'primary', hidden: false, permissions: [], request: {} })) });
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const value = native('ses_created'); value.location = body.location; sessions.set(value.id, value); messages.set(value.id, []); return json({ data: value });
    }
    if (url.pathname === '/api/session') {
      const available = [...sessions.values()].filter(item => !url.searchParams.has('parentID') || item.parentID === url.searchParams.get('parentID'));
      const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 200);
      return json({ data: available.slice(offset, offset + limit), cursor: { next: String(offset + limit) } });
    }
    const match = /^\/api\/(?:experimental\/)?session\/([^/]+)(.*)$/.exec(url.pathname);
    if (match) {
      const id = match[1]!, suffix = match[2], session = sessions.get(id);
      if (!session) return json({ _tag: 'SessionNotFoundError', sessionID: id, message: 'Missing native session' }, 404);
      if (!suffix) {
        if (request.method === 'PATCH') { Object.assign(session, body); response.writeHead(204).end(); event('session.renamed', { sessionID: id, title: session.title }); return; }
        if (state.nativeFailures-- > 0) return json({ _tag: 'UnknownError', message: 'retry native session' }, 503);
        const snapshot = structuredClone(session);
        const barrier = intercept.get(url.pathname); intercept.delete(url.pathname); if (barrier) await barrier();
        return json({ data: snapshot });
      }
      if (suffix === '/message') {
        if (state.historyFailures-- > 0) return json({ _tag: 'UnknownError', message: 'retry history' }, 503);
        if (url.searchParams.has('cursor') && url.searchParams.has('order')) return json({ _tag: 'InvalidRequestError', message: 'Cannot combine cursor and order' }, 400);
        const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 200);
        const data = structuredClone([...(messages.get(id) ?? [])].reverse().slice(offset, offset + limit));
        const barrier = intercept.get(url.pathname); intercept.delete(url.pathname); if (barrier) await barrier();
        return json({ data, cursor: data.length ? { previous: String(Math.max(offset-limit,0)), next: String(offset + limit) } : {} });
      }
      if (suffix === '/instructions/entries') return json({ data: instructions.get(id) ?? [] });
      if (suffix.startsWith('/instructions/entries/')) {
        const key = decodeURIComponent(suffix.split('/').at(-1)!);
        instructions.set(id, [...(instructions.get(id) ?? []).filter(item => item.key !== key), {key, value:body.value}]); response.writeHead(204).end(); return;
      }
      if (suffix === '/model' || suffix === '/agent') { Object.assign(session, body); response.writeHead(204).end(); return; }
      if (/^\/permission\/[^/]+\/reply$/.test(suffix)) { permissions.set(id, []); response.writeHead(204).end(); return; }
      if (/^\/form\/[^/]+(?:\/reply)?$/.test(suffix)) {
        forms.set(id, []);
        if (state.replyFailures-- > 0) return json({ _tag: 'UnknownError', message: 'reply result unavailable' }, 503);
        response.writeHead(204).end(); return;
      }
      if (suffix === '/permission') return json({ data: permissions.get(id) ?? [] });
      if (suffix === '/form') return json({ data: forms.get(id) ?? [] });
      if (suffix === '/inbox') return json({ data: [] });
      if (suffix === '/prompt') {
        if (state.prompt === 'drop') { request.socket.destroy(); return; }
        const message: SessionMessageInfo = { type: 'user', id: body.id, text: body.text, time: { created: Date.now() } };
        if (state.prompt === 'ack-only') return json({ data: { id: body.id, sessionID: id, type: 'user', payload: { text: body.text }, time: message.time, delivery: body.delivery } });
        messages.set(id, [...(messages.get(id) ?? []), message]); active[id] = { type: 'running' };
        if (state.prompt === 'accept-drop') { request.socket.destroy(); return; }
        json({ data: { id: body.id, sessionID: id, type: 'user', payload: { text: body.text }, time: message.time, delivery: body.delivery } });
        event('session.inbox.delivered', { sessionID: id, inboxID: body.id }); event('session.execution.started', { sessionID: id }); return;
      }
      if (suffix === '/interrupt') { delete active[id]; session.outcome = 'interrupted';
        const barrier = intercept.get(url.pathname); intercept.delete(url.pathname); if (barrier) await barrier();
        json({ interrupted: true }); event('session.execution.interrupted', { sessionID: id, reason: 'user' }); return; }
    }
    json({ _tag: 'UnknownError', message: `Unexpected ${request.method} ${url.pathname}` }, 500);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new OpenCodeAgentProvider({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requestTimeoutMs: 2000, ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}) });
  return { provider, messages, active, requests, streams, event, sessions, permissions, forms, state, block, instructions, disconnect() { for (const stream of streams) stream.destroy(); },
    async close() {
      await provider.close();
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

