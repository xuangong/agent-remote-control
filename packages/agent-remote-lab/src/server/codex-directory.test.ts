// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { CodexAppServerProvider } from '../../../agent-provider-codex/src/provider.js';
import { createScriptedAppServer } from '../../../agent-provider-codex/src/test-utils/scripted-app-server.js';
import { createProtocolValidationServer } from '../server.js';
import { createCodexDirectory } from './codex-directory.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map((close) => close())); });

function fixture() {
  let starts = 0;
  const resumed: string[] = [];
  const children: ReturnType<typeof createScriptedAppServer>[] = [];
  const provider = new CodexAppServerProvider({ spawn: () => {
    const app = createScriptedAppServer({
      'thread/list': () => ({ data: [{ id: 'saved', preview: 'Saved conversation', cwd: '/original', createdAt: 1, updatedAt: 2 }], nextCursor: null }),
      'thread/start': () => ({ thread: { id: `created-${++starts}` }, cwd: '/new', model: 'native-model' }),
      'thread/resume': (params) => { const id = (params as { threadId: string }).threadId; resumed.push(id); return { thread: { id }, cwd: '/original', model: 'native-model' }; },
      'thread/read': (params) => ({ thread: { id: (params as { threadId: string }).threadId, turns: [{ id: 'turn-history', items: [{ id: 'message-history', type: 'agentMessage', text: 'Persistent history' }] }] } }),
    });
    children.push(app);
    return app.child;
  } });
  const directory = createCodexDirectory(provider, '/workspace');
  return { provider, directory, children, resumed, starts: () => starts };
}

it('creates one native process and attaches it even before Codex persists the thread', async () => {
  const f = fixture();
  const server = createProtocolValidationServer({ providers: [f.provider], directories: [f.directory], labOrigin: 'http://127.0.0.1:6175' });
  closes.push(() => server.close());
  const { url } = await server.http.listen();
  const create = () => fetch(`${url}/v1/remote/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: 'codex', requestId: 'create-once' }) }).then((r) => r.json());
  const [one, two] = await Promise.all([create(), create()]);
  expect(one).toEqual(two);
  expect(one.nativeSessionId).toBe('created-1');
  expect(f.starts()).toBe(1);
  expect(f.resumed).toEqual([]);
  expect(server.relay.requireAgent(one.agentId).snapshot().payload.providerId).toBe('codex');
  const catalog = await (await fetch(`${url}/v1/remote/catalog?providerId=codex`)).json();
  expect(catalog.items.map((item: { nativeSessionId: string }) => item.nativeSessionId)).toContain('created-1');
  await server.relay.closeAgent(one.agentId);
  const reattach = await (await fetch(`${url}/v1/remote/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'created-1' }) })).json();
  expect(reattach.agentId).not.toBe(one.agentId);
  expect(f.resumed).toEqual(['created-1']);
});

it('imports the selected native thread and reconstructs its history without a new thread', async () => {
  const f = fixture();
  closes.push(() => f.directory.close!());
  expect(await f.directory.list()).toEqual([expect.objectContaining({ nativeSessionId: 'saved', title: 'Saved conversation' })]);
  const session = await f.directory.open('saved');
  const iterator = session.observe()[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ value: { type: 'observation', delivery: 'history' } });
  expect(await session.runtimeInfo()).toMatchObject({ sessionId: 'saved', cwd: '/original', model: 'native-model' });
  expect(f.starts()).toBe(0);
  expect(f.resumed).toEqual(['saved']);
});

it('disposes newly created threads that have not been attached to a Relay', async () => {
  const f = fixture();
  await f.directory.create({});
  await f.directory.close!();
  expect(f.children.every((app) => app.child.killed)).toBe(true);
  await expect(f.directory.create({})).rejects.toThrow('closed');
});
