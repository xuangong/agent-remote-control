import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CopilotAgentProvider} from '../src/provider.js';
import {TimelineStore} from '../../agent-remote-relay/src/timeline-store.js';
import {projectTimelineRows} from '../../agent-remote-relay/src/timeline-projector.js';
import type {AgentSession, ProviderStreamItem} from '@borgee/agent-provider-sdk';

export type ModelRequest = {model: string; messages: Array<{role: string; content: unknown}>};
export function reply(res: ServerResponse, body: ModelRequest, content: string | {name: string; arguments: object}) {
 const tool = typeof content !== 'string';
 const chunk = (delta: unknown, finish_reason: string | null = null) => ({id: 'fixture-completion', object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta, finish_reason}]});
 res.writeHead(200, {'content-type': 'text/event-stream'});
 res.end([chunk(tool ? {role: 'assistant', tool_calls: [{index: 0, id: `fixture-tool-${crypto.randomUUID()}`, type: 'function', function: {name: content.name, arguments: JSON.stringify(content.arguments)}}]} : {role: 'assistant', content: content.slice(0, Math.ceil(content.length / 2))}), ...(!tool ? [chunk({content: content.slice(Math.ceil(content.length / 2))})] : []), chunk({}, tool ? 'tool_calls' : 'stop')].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
}
export async function waitFor(test: () => unknown | Promise<unknown>) {
 const end = Date.now() + 18000;
 while (!await test()) { if (Date.now() > end) throw new Error('Native fixture condition timed out.'); await new Promise(r => setTimeout(r, 20)); }
}
export function observe(session: AgentSession) {
 const items: ProviderStreamItem[] = [];
 const store = new TimelineStore('native-fixture');
 const done = (async () => { for await (const item of session.observe()) {
  items.push(item);
  if (item.type === 'observation' && item.event.type === 'timeline') store.append({providerId: item.event.provider, sourceKey: item.sourceKey, nativeRevision: item.nativeRevision, occurredAt: item.occurredAt, turnId: item.event.turnId, item: item.event.item});
 } })();
 return {items, done, timeline: () => projectTimelineRows(store.rows()), events: () => items.flatMap(i => i.type === 'observation' ? [i.event] : [])};
}
export async function fixture(handler: (body: ModelRequest, res: ServerResponse, index: number) => void) {
 const home = await mkdtemp(join(tmpdir(), 'copilot-native-test-'));
 const cwd = join(home, 'workspace'); await mkdir(cwd);
 const requests: ModelRequest[] = []; const errors: unknown[] = [];
 const server = createServer(async (req, res) => {
  try { const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body); handler(body, res, requests.length); }
  catch (error) { errors.push(error); res.writeHead(500); res.end('Fixture failure'); }
 });
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
 const provider = new CopilotAgentProvider({useLoggedInUser: false, requestTimeoutMs: 5000, env: {COPILOT_HOME: join(home, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined}, nativeSessionConfig: {provider: {type: 'openai', baseUrl: `http://127.0.0.1:${address.port}`, wireApi: 'completions'}}});
 return {home, cwd, provider, requests, errors, async close() {
  try { await provider.dispose(); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(home, {recursive: true, force: true}); }
 }};
}
